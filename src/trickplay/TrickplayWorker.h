#ifndef TRICKPLAYWORKER_H
#define TRICKPLAYWORKER_H

#include <QByteArray>
#include <QCache>
#include <QObject>
#include <QString>

#include <atomic>

#include <mpv/client.h>

///////////////////////////////////////////////////////////////////////////////////////////////////
/// Generates preview frames for the trickplay seek bubble on demand.
///
/// A dedicated, invisible mpv instance is kept on a worker thread. It loads the
/// media URL used by the real player, seeks to the requested position and grabs
/// a JPEG screenshot. Results are cached in memory per cache key.
///
/// The image VO can only hand out a frame as a file, so each capture writes one
/// JPEG into a private temporary directory. That file is deleted as soon as it
/// has been read, and the directory is only readable by the current user.
class TrickplayWorker : public QObject
{
  Q_OBJECT

public:
  explicit TrickplayWorker(bool ignoreSslErrors, const QString& caFile, const QString& userAgent,
                           bool logTimings = false, QObject* parent = nullptr);
  ~TrickplayWorker() override;

  // Thread-safe. Lets the worker abandon a job that is no longer relevant.
  void setLatestRequest(quint64 id);
  void requestShutdown();

public Q_SLOTS:
  /// refine=false stops after the keyframe frame, which is what speculative
  /// (prefetch) requests want: it skips the exact seek that costs most of the
  /// decode and most of the bytes read from the server.
  void generate(quint64 id, const QString& url, qint64 positionMs, int width, const QString& cacheKey,
                bool refine);

  /// Loads url ahead of the first preview so the first hover only pays for a
  /// seek. Safe to call for the stream that is already playing.
  void prepare(const QString& url);

  void shutdown();

Q_SIGNALS:
  /// finalFrame is false for the frame at the keyframe before the requested
  /// position, which is delivered first so a preview appears within ~50ms, and
  /// true for the frame at the requested position.
  void ready(quint64 id, const QString& cacheKey, const QString& dataUrl, int width, int height,
             bool finalFrame);
  void failed(quint64 id, const QString& cacheKey, const QString& error);

private:
  struct Thumbnail {
    // The JPEG is kept as it came out of mpv. A data URL is only built when the
    // frame is delivered: the base64 text is nearly three times the size of the
    // image, and the whole cache is held in memory.
    QByteArray jpeg;
    int width = 0;
    int height = 0;
    bool finalFrame = false;
  };

  enum class SeekMode {
    Keyframe,
    Exact
  };

  bool initializeMpv(QString& error);
  bool ensureTempDir();
  bool loadUrl(quint64 id, const QString& url, QString& error);
  bool seekAndCapture(quint64 id, qint64 positionMs, SeekMode mode, QByteArray& jpeg, int& width,
                      int& height, QString& error);
  bool waitForIdle(quint64 id, int timeoutMs);
  QByteArray takeRenderedFrame(int& width, int& height) const;
  double currentPositionSeconds() const;
  bool applyScale(int width);
  bool isCancelled(quint64 id) const;
  void deliver(quint64 id, const QString& cacheKey, const QByteArray& jpeg, int width, int height,
               bool finalFrame);
  static QString dataUrl(const QByteArray& jpeg);
  void drainEvents();
  void cleanupFiles();
  int runCommand(const QStringList& args);
  static QString normalizeUrl(const QString& url);
  static void removeStaleTempDirs(const QString& ownDir);

  mpv_handle* m_mpv = nullptr;
  bool m_ignoreSslErrors = false;
  QString m_caFile;
  QString m_userAgent;
  bool m_logTimings = false;
  QString m_loadedUrl;
  QString m_tempDir;
  QCache<QString, Thumbnail> m_cache;
  std::atomic<quint64> m_latestId{0};
  std::atomic<bool> m_shutdown{false};
  bool m_initFailed = false;
  int m_scaleWidth = 0;
  // A URL that failed to load is not retried for a while: every attempt costs
  // the full load timeout, and the seek bar asks again for each hovered spot.
  QString m_failedUrl;
  QString m_failedError;
  qint64 m_failedAt = 0;
};

#endif // TRICKPLAYWORKER_H
