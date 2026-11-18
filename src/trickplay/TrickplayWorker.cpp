#include "TrickplayWorker.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDebug>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QStringList>
#include <QThread>
#include <QUrl>
#include <QVector>

namespace {
constexpr int kLoadTimeoutMs = 30000;
constexpr int kSeekTimeoutMs = 15000;
constexpr int kSettleTimeoutMs = 1000;
// The image VO signals a rendered frame by writing a file, so the frame is
// detected one poll late. A short poll keeps that below a frame time.
constexpr double kFramePollSeconds = 0.002;
constexpr int kStaleTempDirHours = 1;
// How long a stream that failed to load is remembered, so the next preview does
// not start another half-minute of timeouts against the same broken URL.
constexpr qint64 kLoadFailureMemoryMs = 60000;
constexpr int kCacheEntries = 500;
// A keyframe seek lands on the previous keyframe, which is exactly the
// requested frame when the two are this close. Anything further away gets the
// exact seek afterwards, so a preview always ends up on the requested frame.
constexpr qint64 kRefineToleranceMs = 100;

// Where the captured frame was really taken. A seek can land on an earlier
// keyframe, and the preview label has to follow the image.
qint64 frameTimeMs(double positionMs, qint64 fallbackMs)
{
  return positionMs >= 0 ? qRound64(positionMs) : fallbackMs;
}

QString mpvErrorString(int error)
{
  const char* str = mpv_error_string(error);
  return str ? QString::fromUtf8(str) : QString::number(error);
}
}

///////////////////////////////////////////////////////////////////////////////////////////////////
TrickplayWorker::TrickplayWorker(bool ignoreSslErrors, const QString& caFile, const QString& userAgent,
                                 bool logTimings, QObject* parent)
  : QObject(parent)
  , m_ignoreSslErrors(ignoreSslErrors)
  , m_caFile(caFile)
  , m_userAgent(userAgent)
  , m_logTimings(logTimings)
{
  m_cache.setMaxCost(kCacheEntries);
  m_tempDir = QDir(QDir::tempPath()).filePath(
    QStringLiteral("jellyfin-desktop-trickplay-%1").arg(QCoreApplication::applicationPid()));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
TrickplayWorker::~TrickplayWorker()
{
  if (m_mpv) {
    mpv_terminate_destroy(m_mpv);
    m_mpv = nullptr;
  }

  if (!m_tempDir.isEmpty())
    QDir(m_tempDir).removeRecursively();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::setLatestRequest(quint64 id)
{
  m_latestId.store(id);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::requestShutdown()
{
  m_shutdown.store(true);
  m_latestId.store(0);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::isCancelled(quint64 id) const
{
  return m_shutdown.load() || id != m_latestId.load();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::shutdown()
{
  if (m_mpv) {
    mpv_terminate_destroy(m_mpv);
    m_mpv = nullptr;
  }

  if (!m_tempDir.isEmpty())
    QDir(m_tempDir).removeRecursively();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString TrickplayWorker::normalizeUrl(const QString& url)
{
  // mpv expects URLs to be percent-encoded, but plain local paths should be
  // passed through untouched.
  if (url.startsWith(QLatin1String("http://"), Qt::CaseInsensitive) ||
      url.startsWith(QLatin1String("https://"), Qt::CaseInsensitive)) {
    return QUrl(url).toString(QUrl::FullyEncoded);
  }

  return url;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
int TrickplayWorker::runCommand(const QStringList& args)
{
  QVector<QByteArray> storage;
  storage.reserve(args.size());

  for (const QString& arg : args)
    storage.append(arg.toUtf8());

  QVector<const char*> argv;
  argv.reserve(storage.size() + 1);

  for (const QByteArray& arg : storage)
    argv.append(arg.constData());

  argv.append(nullptr);

  return mpv_command(m_mpv, argv.data());
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::drainEvents()
{
  if (!m_mpv)
    return;

  while (true) {
    mpv_event* event = mpv_wait_event(m_mpv, 0);
    if (!event || event->event_id == MPV_EVENT_NONE)
      break;
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::cleanupFiles()
{
  if (m_tempDir.isEmpty())
    return;

  QDir dir(m_tempDir);
  const QFileInfoList files = dir.entryInfoList(QDir::Files | QDir::NoDotAndDotDot);
  for (const QFileInfo& file : files)
    QFile::remove(file.absoluteFilePath());
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::removeStaleTempDirs(const QString& ownDir)
{
  // A capture writes a frame of the video being watched, so a directory left
  // behind by a process that was killed must not stay there. Directories of
  // other running instances are left alone; ours is excluded explicitly.
  QDir temp(QDir::tempPath());
  const QStringList candidates = temp.entryList({ QStringLiteral("jellyfin-desktop-trickplay-*") },
                                                QDir::Dirs | QDir::NoDotAndDotDot);

  for (const QString& name : candidates) {
    const QString path = temp.filePath(name);
    if (QDir(path).absolutePath() == QDir(ownDir).absolutePath())
      continue;

    const QDateTime modified = QFileInfo(path).lastModified();
    if (modified.isValid() && modified.secsTo(QDateTime::currentDateTime()) > kStaleTempDirHours * 3600)
      QDir(path).removeRecursively();
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::ensureTempDir()
{
  if (m_tempDir.isEmpty())
    return false;

  removeStaleTempDirs(m_tempDir);

  if (!QDir().mkpath(m_tempDir))
    return false;

  // Only this user may read the frames of the media being previewed. mpv
  // creates the files themselves with the default umask, which is harmless
  // inside a directory nobody else can enter.
#ifdef Q_OS_WIN
  // Windows has no POSIX permission bits, so there is nothing to narrow here:
  // the directory inherits the ACL of the per-user temporary directory, which
  // is what keeps the frames private.
  return true;
#else
  return QFile::setPermissions(m_tempDir, QFileDevice::ReadOwner | QFileDevice::WriteOwner
                                           | QFileDevice::ExeOwner);
#endif
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::initializeMpv(QString& error)
{
  if (m_mpv)
    return true;

  if (m_initFailed) {
    error = tr("Trickplay player could not be initialized");
    return false;
  }

  if (!ensureTempDir()) {
    m_initFailed = true;
    error = tr("Could not create trickplay temporary directory");
    return false;
  }

  mpv_handle* mpv = mpv_create();
  if (!mpv) {
    m_initFailed = true;
    error = tr("Could not create trickplay player");
    return false;
  }

  mpv_set_option_string(mpv, "config", "no");
  mpv_set_option_string(mpv, "vo", "image");
  mpv_set_option_string(mpv, "vo-image-outdir", m_tempDir.toUtf8().constData());
  mpv_set_option_string(mpv, "vo-image-format", "jpg");
  mpv_set_option_string(mpv, "vo-image-jpeg-quality", "80");
  mpv_set_option_string(mpv, "audio", "no");
  mpv_set_option_string(mpv, "pause", "yes");
  mpv_set_option_string(mpv, "keep-open", "yes");
  mpv_set_option_string(mpv, "hr-seek", "yes");
  mpv_set_option_string(mpv, "force-window", "no");
  mpv_set_option_string(mpv, "osc", "no");
  mpv_set_option_string(mpv, "osd-level", "0");
  mpv_set_option_string(mpv, "input-default-bindings", "no");
  mpv_set_option_string(mpv, "input-vo-keyboard", "no");
  mpv_set_option_string(mpv, "sub-auto", "no");
  // A preview decodes up to a whole keyframe interval to reach one frame, and on
  // 4K that decode outranks everything else. Copy-back mode keeps the frames in
  // system memory, which the image output needs, and measured about three times
  // faster than software decoding on 4K HEVC. The "safe" variant leaves codecs
  // and devices that are known to be broken on the software decoder.
  mpv_set_option_string(mpv, "hwdec", "auto-copy-safe");
  mpv_set_option_string(mpv, "demuxer-mkv-probe-start-time", "no");

  // Previews share the connection with playback, so they must not read ahead:
  // with the demuxer cache enabled every seek pulls a large chunk of the file
  // off the server again and the real player starts to stall.
  mpv_set_option_string(mpv, "cache", "no");
  mpv_set_option_string(mpv, "demuxer-readahead-secs", "1");
  mpv_set_option_string(mpv, "demuxer-max-bytes", "4MiB");
  mpv_set_option_string(mpv, "demuxer-max-back-bytes", "1MiB");

  // A 400px thumbnail does not need the full decoder: keep the preview cheap
  // so it cannot starve the player of CPU while it decodes. Two threads were
  // half as fast as four on 4K, while more than four made it slower again.
  mpv_set_option_string(mpv, "vd-lavc-threads", "4");
  mpv_set_option_string(mpv, "vd-lavc-skiploopfilter", "all");
  mpv_set_option_string(mpv, "msg-level", "all=error");
  if (!m_userAgent.isEmpty())
    mpv_set_option_string(mpv, "user-agent", m_userAgent.toUtf8().constData());

  if (m_ignoreSslErrors) {
    mpv_set_option_string(mpv, "tls-ca-file", "");
    mpv_set_option_string(mpv, "tls-verify", "no");
  } else if (!m_caFile.isEmpty()) {
    mpv_set_option_string(mpv, "tls-ca-file", m_caFile.toUtf8().constData());
    mpv_set_option_string(mpv, "tls-verify", "yes");
  } else {
    mpv_set_option_string(mpv, "tls-verify", "yes");
  }

  const int rc = mpv_initialize(mpv);
  if (rc < 0) {
    m_initFailed = true;
    error = tr("Could not initialize trickplay player: %1").arg(mpvErrorString(rc));
    mpv_terminate_destroy(mpv);
    return false;
  }

  m_mpv = mpv;

  if (m_logTimings) {
    char* hwdec = nullptr;
    if (mpv_get_property(mpv, "hwdec-current", MPV_FORMAT_STRING, &hwdec) >= 0 && hwdec) {
      qDebug() << "Trickplay preview decoder:" << hwdec;
      mpv_free(hwdec);
    }
  }

  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::applyScale(int width)
{
  if (!m_mpv)
    return false;

  width = qBound(64, width, 1024);
  if (width == m_scaleWidth)
    return true;

  // The image VO writes full-size frames by default. Downscale them to keep
  // the thumbnails (and the base64 payload sent to the web client) small. The
  // box filter costs the same as bilinear here and does not alias on the detail
  // a 4K source loses when it is shrunk to 400px.
  const QString filter = QStringLiteral("scale=%1:-2:flags=area").arg(width);
  const int rc = mpv_set_property_string(m_mpv, "vf", filter.toUtf8().constData());

  if (rc < 0) {
    // libavfilter may be unavailable. Full-size screenshots still work.
    mpv_set_property_string(m_mpv, "vf", "");
    m_scaleWidth = width;
    return true;
  }

  m_scaleWidth = width;
  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::loadUrl(quint64 id, const QString& url, QString& error)
{
  if (m_loadedUrl == url)
    return true;

  m_loadedUrl.clear();
  drainEvents();

  // Disable audio and subtitle tracks for the preview. Without this, the
  // image output could render subtitles into the thumbnail.
  const int rc = runCommand({
    QStringLiteral("loadfile"),
    normalizeUrl(url),
    QStringLiteral("replace"),
    QStringLiteral("-1"),
    QStringLiteral("aid=no,sid=no,secondary-sid=no")
  });
  if (rc < 0) {
    error = tr("Could not load media for trickplay: %1").arg(mpvErrorString(rc));
    return false;
  }

  QElapsedTimer timer;
  timer.start();

  // Loading another video ends the previously loaded one first, so an end-file
  // is only a failure once the new stream has started (or it reported an
  // error). Otherwise every preview after the first video would be dropped.
  bool started = false;

  while (timer.elapsed() < kLoadTimeoutMs) {
    if (isCancelled(id))
      return false;

    mpv_event* event = mpv_wait_event(m_mpv, 0.1);
    if (!event)
      continue;

    if (event->event_id == MPV_EVENT_START_FILE) {
      started = true;
      continue;
    }

    if (event->event_id == MPV_EVENT_FILE_LOADED) {
      m_loadedUrl = url;
      return true;
    }

    if (event->event_id == MPV_EVENT_END_FILE) {
      const auto* endFile = static_cast<const mpv_event_end_file*>(event->data);
      const bool failed = started || (endFile && endFile->reason == MPV_END_FILE_REASON_ERROR);

      if (failed) {
        error = tr("Could not load media for trickplay");
        return false;
      }
    }
  }

  error = tr("Timed out loading media for trickplay");
  return false;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QByteArray TrickplayWorker::takeRenderedFrame(int& width, int& height) const
{
  const QFileInfoList files =
    QDir(m_tempDir).entryInfoList({ QStringLiteral("*.jpg") }, QDir::Files, QDir::Time);

  for (const QFileInfo& info : files) {
    QFile file(info.absoluteFilePath());
    if (!file.open(QIODevice::ReadOnly))
      continue;

    const QByteArray data = file.readAll();
    file.close();

    // mpv creates the file before it has written all of it. Only take a frame
    // that ends with the JPEG end marker, otherwise the preview would show a
    // half decoded image.
    if (!data.endsWith("\xFF\xD9"))
      continue;

    QImage image;
    if (data.isEmpty() || !image.loadFromData(data, "JPEG"))
      continue;

    width = image.width();
    height = image.height();
    return data;
  }

  return {};
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::waitForIdle(quint64 id, int timeoutMs)
{
  QElapsedTimer timer;
  timer.start();

  while (timer.elapsed() < timeoutMs) {
    if (isCancelled(id))
      return false;

    int seeking = 0;
    if (mpv_get_property(m_mpv, "seeking", MPV_FORMAT_FLAG, &seeking) < 0 || !seeking)
      return true;

    QThread::msleep(10);
  }

  return !isCancelled(id);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
double TrickplayWorker::currentPositionSeconds() const
{
  double position = 0;
  if (!m_mpv || mpv_get_property(m_mpv, "time-pos", MPV_FORMAT_DOUBLE, &position) < 0)
    return -1;

  return position;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayWorker::seekAndCapture(quint64 id, qint64 positionMs, SeekMode mode, QByteArray& jpeg,
                                     int& width, int& height, QString& error)
{
  double duration = 0;
  mpv_get_property(m_mpv, "duration", MPV_FORMAT_DOUBLE, &duration);

  double position = qMax<qint64>(0, positionMs) / 1000.0;
  if (duration > 0.1)
    position = qMin(position, qMax(0.0, duration - 0.1));

  // A preview that was abandoned mid-seek can still render a frame after we
  // take over. Let mpv settle and drop those frames first, so the frame we
  // read below can only come from this seek.
  if (!waitForIdle(id, kSettleTimeoutMs))
    return false;

  // The directory can disappear under us (a temp cleaner, or a later version
  // of this code); mpv would then fail to write the frame.
  if (!QDir(m_tempDir).exists() && !ensureTempDir())
    return false;

  cleanupFiles();
  drainEvents();

  // Decoding from the keyframe before the position to the position itself is
  // what makes a preview slow, so the first frame comes from the keyframe.
  const int rc = runCommand({
    QStringLiteral("seek"),
    QString::number(position, 'f', 3),
    mode == SeekMode::Exact ? QStringLiteral("absolute+exact") : QStringLiteral("absolute+keyframes")
  });

  if (rc < 0) {
    error = tr("Could not seek for trickplay: %1").arg(mpvErrorString(rc));
    return false;
  }

  // The image output writes one file per rendered frame, so a new file is the
  // only reliable sign that the frame at the requested position has actually
  // been rendered. Screenshots taken earlier would show the previous frame.
  QElapsedTimer timer;
  timer.start();

  while (timer.elapsed() < kSeekTimeoutMs) {
    if (isCancelled(id))
      return false;

    mpv_event* event = mpv_wait_event(m_mpv, kFramePollSeconds);
    if (event && event->event_id == MPV_EVENT_END_FILE) {
      // Seeking at the very end of the file can unload it. Do not retry, the
      // caller will simply not show a preview for this position.
      error = tr("Could not seek to the requested position");
      return false;
    }

    jpeg = takeRenderedFrame(width, height);
    if (!jpeg.isEmpty()) {
      // The frame is in memory now; nothing of the video stays behind on disk.
      cleanupFiles();
      return true;
    }
  }

  error = tr("Timed out rendering trickplay frame");
  return false;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString TrickplayWorker::dataUrl(const QByteArray& jpeg)
{
  return QStringLiteral("data:image/jpeg;base64,") + QString::fromLatin1(jpeg.toBase64());
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::deliver(quint64 id, const QString& cacheKey, const QByteArray& jpeg, int width,
                              int height, bool finalFrame, qint64 framePositionMs)
{
  Thumbnail* thumbnail = new Thumbnail;
  thumbnail->jpeg = jpeg;
  thumbnail->width = width;
  thumbnail->height = height;
  thumbnail->positionMs = framePositionMs;
  thumbnail->finalFrame = finalFrame;
  m_cache.insert(cacheKey, thumbnail);

  emit ready(id, cacheKey, dataUrl(jpeg), width, height, finalFrame, framePositionMs);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::prepare(const QString& url)
{
  if (m_shutdown.load() || url.isEmpty())
    return;

  QString error;
  if (!initializeMpv(error))
    return;

  if (loadUrl(m_latestId.load(), url, error)) {
    // The stream is readable again, so a remembered failure no longer applies.
    m_failedUrl.clear();
    m_failedError.clear();
    return;
  }

  // Nothing is playing yet, so a failure here is not worth reporting: the
  // request that needs the stream will load it and report the real error.
  m_loadedUrl.clear();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::generate(quint64 id, const QString& url, qint64 positionMs, int width,
                               const QString& cacheKey, bool refine)
{
  if (isCancelled(id))
    return;

  // A cheap frame for this position is already on screen; the exact one is the
  // only thing left, so the keyframe seek below would be repeated for nothing.
  bool haveCheapFrame = false;

  if (const Thumbnail* cached = m_cache.object(cacheKey)) {
    if (cached->finalFrame) {
      emit ready(id, cacheKey, dataUrl(cached->jpeg), cached->width, cached->height, true,
                 cached->positionMs);
      return;
    }

    // The cheap frame is all a background request asked for, and it is here.
    if (!refine) {
      emit ready(id, cacheKey, dataUrl(cached->jpeg), cached->width, cached->height, false,
                 cached->positionMs);
      return;
    }

    haveCheapFrame = true;
  }

  QString error;
  if (!initializeMpv(error)) {
    if (!isCancelled(id))
      emit failed(id, cacheKey, error);
    return;
  }

  applyScale(width);

  // Retrying a stream that just failed only repeats the same timeout. The
  // seek bar asks for every hovered spot, so failing fast is what keeps a
  // broken item from occupying the worker for a minute at a time.
  if (url == m_failedUrl
      && QDateTime::currentMSecsSinceEpoch() - m_failedAt < kLoadFailureMemoryMs) {
    if (!isCancelled(id))
      emit failed(id, cacheKey, m_failedError);
    return;
  }

  QElapsedTimer timer;
  timer.start();

  if (!loadUrl(id, url, error)) {
    if (isCancelled(id))
      return;

    m_failedUrl = url;
    m_failedError = error;
    m_failedAt = QDateTime::currentMSecsSinceEpoch();
    emit failed(id, cacheKey, error);
    return;
  }

  m_failedUrl.clear();
  m_failedError.clear();

  const qint64 loadMs = timer.restart();

  QByteArray jpeg;
  int frameWidth = 0;
  int frameHeight = 0;

  if (!haveCheapFrame) {
    if (!seekAndCapture(id, positionMs, SeekMode::Keyframe, jpeg, frameWidth, frameHeight, error)) {
      // A failed seek can unload the file (for example when it lands on the very
      // end), so the next request has to load it again.
      m_loadedUrl.clear();
      if (!isCancelled(id))
        emit failed(id, cacheKey, error);
      return;
    }

    const qint64 keyframeMs = timer.elapsed();
    const double landedMs = currentPositionSeconds() * 1000.0;
    const qint64 keyframePositionMs = frameTimeMs(landedMs, positionMs);

    // Keyframe seeking lands on the previous keyframe, which is up to one
    // keyframe interval early. When that is close enough the frame is already
    // the one the exact seek would produce, so the expensive pass is skipped.
    const bool exactEnough = landedMs >= 0 && qAbs(landedMs - positionMs) <= kRefineToleranceMs;

    if (exactEnough) {
      if (m_logTimings) {
        qDebug() << "Trickplay frame ready at" << positionMs << "ms: load" << loadMs << "ms, keyframe"
                 << keyframeMs << "ms, exact (same keyframe)";
      }
      deliver(id, cacheKey, jpeg, frameWidth, frameHeight, true, keyframePositionMs);
      return;
    }

    if (m_logTimings) {
      qDebug() << "Trickplay frame at" << positionMs << "ms from keyframe" << landedMs << "ms: load"
               << loadMs << "ms, keyframe" << keyframeMs << "ms" << (refine ? "" : ", no refine");
    }

    deliver(id, cacheKey, jpeg, frameWidth, frameHeight, false, keyframePositionMs);

    // A speculative request is answered by the cheap frame; the position it
    // guessed may never be looked at, so decoding up to it would be wasted.
    if (!refine)
      return;
  }

  if (isCancelled(id))
    return;

  timer.restart();

  if (!seekAndCapture(id, positionMs, SeekMode::Exact, jpeg, frameWidth, frameHeight, error)) {
    // The keyframe frame is already on screen; the caller keeps it.
    m_loadedUrl.clear();
    if (!isCancelled(id))
      emit failed(id, cacheKey, tr("Could not refine the preview frame: %1").arg(error));
    return;
  }

  if (m_logTimings)
    qDebug() << "Trickplay frame refined at" << positionMs << "ms: exact" << timer.elapsed() << "ms";

  deliver(id, cacheKey, jpeg, frameWidth, frameHeight, true,
          frameTimeMs(currentPositionSeconds() * 1000.0, positionMs));
}
