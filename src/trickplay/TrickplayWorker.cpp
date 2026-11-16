#include "TrickplayWorker.h"

#include <QCoreApplication>
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
constexpr int kCacheEntries = 300;

QString mpvErrorString(int error)
{
  const char* str = mpv_error_string(error);
  return str ? QString::fromUtf8(str) : QString::number(error);
}
}

///////////////////////////////////////////////////////////////////////////////////////////////////
TrickplayWorker::TrickplayWorker(bool ignoreSslErrors, const QString& caFile, const QString& userAgent, QObject* parent)
  : QObject(parent)
  , m_ignoreSslErrors(ignoreSslErrors)
  , m_caFile(caFile)
  , m_userAgent(userAgent)
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
bool TrickplayWorker::initializeMpv(QString& error)
{
  if (m_mpv)
    return true;

  if (m_initFailed) {
    error = tr("Trickplay player could not be initialized");
    return false;
  }

  if (!QDir().mkpath(m_tempDir)) {
    m_initFailed = true;
    error = tr("Could not create trickplay temporary directory");
    return false;
  }

  cleanupFiles();

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
  mpv_set_option_string(mpv, "hwdec", "no");
  mpv_set_option_string(mpv, "demuxer-mkv-probe-start-time", "no");
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
  // the thumbnails (and the base64 payload sent to the web client) small.
  const QString filter = QStringLiteral("scale=%1:-2:flags=bilinear").arg(width);
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
bool TrickplayWorker::seekAndCapture(quint64 id, qint64 positionMs, QByteArray& jpeg, int& width, int& height, QString& error)
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

  cleanupFiles();
  drainEvents();

  const int rc = runCommand({
    QStringLiteral("seek"),
    QString::number(position, 'f', 3),
    QStringLiteral("absolute+exact")
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

    mpv_event* event = mpv_wait_event(m_mpv, 0.02);
    if (event && event->event_id == MPV_EVENT_END_FILE) {
      // Seeking at the very end of the file can unload it. Do not retry, the
      // caller will simply not show a preview for this position.
      error = tr("Could not seek to the requested position");
      return false;
    }

    jpeg = takeRenderedFrame(width, height);
    if (!jpeg.isEmpty())
      return true;
  }

  error = tr("Timed out rendering trickplay frame");
  return false;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayWorker::generate(quint64 id, const QString& url, qint64 positionMs, int width, const QString& cacheKey)
{
  if (isCancelled(id))
    return;

  if (const Thumbnail* cached = m_cache.object(cacheKey)) {
    emit ready(id, cacheKey, cached->dataUrl, cached->width, cached->height);
    return;
  }

  QString error;
  if (!initializeMpv(error)) {
    if (!isCancelled(id))
      emit failed(id, cacheKey, error);
    return;
  }

  applyScale(width);

  if (!loadUrl(id, url, error)) {
    if (!isCancelled(id))
      emit failed(id, cacheKey, error);
    return;
  }

  QByteArray jpeg;
  int frameWidth = 0;
  int frameHeight = 0;

  if (!seekAndCapture(id, positionMs, jpeg, frameWidth, frameHeight, error)) {
    // A failed seek can unload the file (for example when it lands on the very
    // end), so the next request has to load it again.
    m_loadedUrl.clear();
    if (!isCancelled(id))
      emit failed(id, cacheKey, error);
    return;
  }

  const QString dataUrl = QStringLiteral("data:image/jpeg;base64,") + QString::fromLatin1(jpeg.toBase64());

  Thumbnail* thumbnail = new Thumbnail;
  thumbnail->dataUrl = dataUrl;
  thumbnail->width = frameWidth;
  thumbnail->height = frameHeight;
  m_cache.insert(cacheKey, thumbnail);

  emit ready(id, cacheKey, dataUrl, frameWidth, frameHeight);
}
