#ifndef TRICKPLAYWORKER_H
#define TRICKPLAYWORKER_H

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
class TrickplayWorker : public QObject
{
  Q_OBJECT

public:
  explicit TrickplayWorker(bool ignoreSslErrors, const QString& caFile, const QString& userAgent, QObject* parent = nullptr);
  ~TrickplayWorker() override;

  // Thread-safe. Lets the worker abandon a job that is no longer relevant.
  void setLatestRequest(quint64 id);
  void requestShutdown();

public Q_SLOTS:
  void generate(quint64 id, const QString& url, qint64 positionMs, int width, const QString& cacheKey);
  void shutdown();

Q_SIGNALS:
  void ready(quint64 id, const QString& cacheKey, const QString& dataUrl, int width, int height);
  void failed(quint64 id, const QString& cacheKey, const QString& error);

private:
  struct Thumbnail {
    QString dataUrl;
    int width = 0;
    int height = 0;
  };

  bool initializeMpv(QString& error);
  bool loadUrl(quint64 id, const QString& url, QString& error);
  bool seekAndCapture(quint64 id, qint64 positionMs, QByteArray& jpeg, int& width, int& height, QString& error);
  bool waitForIdle(quint64 id, int timeoutMs);
  QByteArray takeRenderedFrame(int& width, int& height) const;
  bool applyScale(int width);
  bool isCancelled(quint64 id) const;
  void drainEvents();
  void cleanupFiles();
  int runCommand(const QStringList& args);
  static QString normalizeUrl(const QString& url);

  mpv_handle* m_mpv = nullptr;
  bool m_ignoreSslErrors = false;
  QString m_caFile;
  QString m_userAgent;
  QString m_loadedUrl;
  QString m_tempDir;
  QCache<QString, Thumbnail> m_cache;
  std::atomic<quint64> m_latestId{0};
  std::atomic<bool> m_shutdown{false};
  bool m_initFailed = false;
  int m_scaleWidth = 0;
};

#endif // TRICKPLAYWORKER_H
