#include "TrickplayComponent.h"

#include <QDebug>
#include <QMetaObject>
#include <QThread>

#include "TrickplayWorker.h"
#include "system/SystemComponent.h"
#include "settings/SettingsComponent.h"
#include "settings/SettingsSection.h"
#include "utils/Log.h"

///////////////////////////////////////////////////////////////////////////////////////////////////
TrickplayComponent::TrickplayComponent(QObject* parent)
  : ComponentBase(parent)
{
}

///////////////////////////////////////////////////////////////////////////////////////////////////
TrickplayComponent::~TrickplayComponent()
{
  if (m_worker) {
    m_worker->requestShutdown();
    QMetaObject::invokeMethod(m_worker, "shutdown", Qt::BlockingQueuedConnection);
  }

  if (m_thread) {
    m_thread->quit();
    m_thread->wait();
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool TrickplayComponent::componentInitialize()
{
  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayComponent::ensureWorker()
{
  if (m_worker)
    return;

  m_thread = new QThread(this);
  m_thread->setObjectName(QStringLiteral("TrickplayWorker"));

  bool ignoreSslErrors = false;
  QString caFile;

  // Settings are not available in every context (for example unit tests).
  if (SettingsComponent::Get().getSection(SETTINGS_SECTION_MAIN)) {
    ignoreSslErrors = SettingsComponent::Get().ignoreSSLErrors();

#if !defined(Q_OS_WIN) && !defined(Q_OS_MAC)
    if (!ignoreSslErrors && SettingsComponent::Get().autodetectCertBundle())
      caFile = SettingsComponent::Get().detectCertBundlePath();
#endif
  }

  m_worker = new TrickplayWorker(ignoreSslErrors, caFile, SystemComponent::Get().getUserAgent());
  m_worker->moveToThread(m_thread);

  connect(m_thread, &QThread::finished, m_worker, &QObject::deleteLater);
  connect(m_worker, &TrickplayWorker::ready, this, &TrickplayComponent::onReady);
  connect(m_worker, &TrickplayWorker::failed, this, &TrickplayComponent::onFailed);

  m_thread->start();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayComponent::requestThumbnail(const QString& url, qint64 positionMs, int width, const QString& cacheKey)
{
  if (url.isEmpty() || cacheKey.isEmpty() || positionMs < 0)
    return;

  ensureWorker();

  const quint64 id = ++m_nextRequestId;
  m_latestRequestId = id;

  // This is a plain atomic store, safe to call from the main thread while the
  // worker is busy. It makes the worker abandon the previous request.
  m_worker->setLatestRequest(id);

  QMetaObject::invokeMethod(m_worker, "generate", Qt::QueuedConnection,
                            Q_ARG(quint64, id),
                            Q_ARG(QString, url),
                            Q_ARG(qint64, positionMs),
                            Q_ARG(int, width),
                            Q_ARG(QString, cacheKey));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayComponent::onReady(quint64 id, const QString& cacheKey, const QString& dataUrl, int width, int height)
{
  if (id != m_latestRequestId)
    return;

  emit thumbnailReady(cacheKey, dataUrl, width, height);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void TrickplayComponent::onFailed(quint64 id, const QString& cacheKey, const QString& error)
{
  if (id != m_latestRequestId)
    return;

  QString censored = error;
  Log::CensorAuthTokens(censored);
  qWarning() << "Trickplay preview failed:" << censored;

  emit thumbnailFailed(cacheKey, censored);
}
