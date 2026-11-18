#ifndef TRICKPLAYCOMPONENT_H
#define TRICKPLAYCOMPONENT_H

#include <QObject>

#include "core/ComponentManager.h"

class QThread;
class TrickplayWorker;

///////////////////////////////////////////////////////////////////////////////////////////////////
/// Exposes on-the-fly trickplay thumbnails to the web client.
///
/// The web client normally reads preview frames from images that the Jellyfin
/// server generated ahead of time with a scheduled task. This component lets
/// the desktop client produce those frames itself, straight from the stream
/// that is currently playing, so no server-side generation is required.
class TrickplayComponent : public ComponentBase
{
  Q_OBJECT
  DEFINE_SINGLETON(TrickplayComponent);

public:
  explicit TrickplayComponent(QObject* parent = nullptr);
  ~TrickplayComponent() override;

  const char* componentName() override { return "trickplay"; }
  bool componentExport() override { return true; }
  bool componentInitialize() override;

  /// Requests a preview frame from url at positionMs. The result is delivered
  /// asynchronously through thumbnailReady() or thumbnailFailed(), keyed by
  /// cacheKey so the caller can match it to the request. thumbnailReady() can
  /// arrive twice for one request: first with the frame at the keyframe before
  /// positionMs, then with the frame at positionMs itself. refine=false asks
  /// for the first of the two only, which is enough for a speculative frame.
  Q_INVOKABLE void requestThumbnail(const QString& url, qint64 positionMs, int width,
                                    const QString& cacheKey, bool refine);

  /// Loads url into the preview player before the first frame is requested, so
  /// the first hover does not pay for opening the stream.
  Q_INVOKABLE void prepare(const QString& url);

Q_SIGNALS:
  void thumbnailReady(const QString& cacheKey, const QString& dataUrl, int width, int height,
                      bool finalFrame);
  void thumbnailFailed(const QString& cacheKey, const QString& error);

private:
  void ensureWorker();
  void onReady(quint64 id, const QString& cacheKey, const QString& dataUrl, int width, int height, bool finalFrame);
  void onFailed(quint64 id, const QString& cacheKey, const QString& error);

  QThread* m_thread = nullptr;
  TrickplayWorker* m_worker = nullptr;
  quint64 m_nextRequestId = 0;
  quint64 m_latestRequestId = 0;
};

#endif // TRICKPLAYCOMPONENT_H
