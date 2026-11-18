#include <QtTest/QtTest>

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QColor>
#include <QImage>
#include <QSignalSpy>

#include "../src/trickplay/TrickplayComponent.h"
#include "../src/trickplay/TrickplayWorker.h"

namespace {
char dominantColor(const QColor& color)
{
  const bool red = color.red() > 150;
  const bool green = color.green() > 150;
  const bool blue = color.blue() > 150;

  if (red && green)
    return blue ? 'w' : 'y';
  if (red && blue)
    return 'm';
  if (green && blue)
    return 'c';

  return red ? 'r' : green ? 'g' : blue ? 'b' : '?';
}

QImage decodeThumbnail(const QString& dataUrl)
{
  const QString prefix = QStringLiteral("data:image/jpeg;base64,");
  QImage image;
  image.loadFromData(QByteArray::fromBase64(dataUrl.mid(prefix.size()).toLatin1()), "JPEG");
  return image;
}

// A request is answered by the frame at the keyframe first (finalFrame false)
// and by the frame at the requested position afterwards (finalFrame true).
QList<QVariant> frameAtRequestedPosition(const QSignalSpy& spy)
{
  for (int index = 0; index < spy.count(); ++index) {
    const QList<QVariant> args = spy.at(index);
    if (args.size() > 5 && args.at(5).toBool())
      return args;
  }

  return {};
}

QList<QVariant> finalThumbnail(const QSignalSpy& spy)
{
  for (int index = 0; index < spy.count(); ++index) {
    const QList<QVariant> args = spy.at(index);
    if (args.size() > 4 && args.at(4).toBool())
      return args;
  }

  return {};
}
}

class TestTrickplay : public QObject
{
  Q_OBJECT

private slots:
  void testGeneratesFrameAtRequestedPosition();
  void testDifferentPositionsAndCache();
  void testSwitchingMedia();
  void testFrameMatchesRequestedPosition();
  void testMissingMediaFails();
  void testKeyframeFrameArrivesFirst();
  void testTempDirStaysPrivate();
  void testComponentDeliversThumbnail();
};

void TestTrickplay::testGeneratesFrameAtRequestedPosition()
{
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);
  QSignalSpy failedSpy(&worker, &TrickplayWorker::failed);

  worker.setLatestRequest(1);
  worker.generate(1, media, 500, 160, QStringLiteral("item|1"));

  QCOMPARE(failedSpy.count(), 0);
  const QList<QVariant> args = frameAtRequestedPosition(readySpy);
  QVERIFY(!args.isEmpty());
  QCOMPARE(args.at(0).toULongLong(), 1ULL);
  QCOMPARE(args.at(1).toString(), QStringLiteral("item|1"));

  const QString dataUrl = args.at(2).toString();
  const QString prefix = QStringLiteral("data:image/jpeg;base64,");
  QVERIFY(dataUrl.startsWith(prefix));
  QCOMPARE(args.at(3).toInt(), 160);
  QCOMPARE(args.at(4).toInt(), 90);

  const QByteArray jpeg = QByteArray::fromBase64(dataUrl.mid(prefix.size()).toLatin1());
  QImage image;
  QVERIFY(image.loadFromData(jpeg, "JPEG"));
  QCOMPARE(image.size(), QSize(160, 90));
}

void TestTrickplay::testDifferentPositionsAndCache()
{
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);
  QSignalSpy failedSpy(&worker, &TrickplayWorker::failed);

  worker.setLatestRequest(1);
  worker.generate(1, media, 500, 160, QStringLiteral("item|first"));
  QCOMPARE(failedSpy.count(), 0);
  const QString first = frameAtRequestedPosition(readySpy).at(2).toString();

  readySpy.clear();
  worker.setLatestRequest(2);
  worker.generate(2, media, 2500, 160, QStringLiteral("item|second"));
  QCOMPARE(failedSpy.count(), 0);
  const QString second = frameAtRequestedPosition(readySpy).at(2).toString();

  QVERIFY2(first != second, "Different positions should produce different frames");

  // A cached key is answered from memory and yields the exact same frame.
  readySpy.clear();
  worker.setLatestRequest(3);
  worker.generate(3, media, 500, 160, QStringLiteral("item|first"));
  QCOMPARE(failedSpy.count(), 0);
  QCOMPARE(readySpy.count(), 1);
  QCOMPARE(readySpy.at(0).at(2).toString(), first);
}

void TestTrickplay::testSwitchingMedia()
{
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  const QString otherMedia = QFINDTESTDATA("data/trickplay-alt.mp4");
  QVERIFY2(!otherMedia.isEmpty(), "Second test video not found");

  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);
  QSignalSpy failedSpy(&worker, &TrickplayWorker::failed);

  worker.setLatestRequest(1);
  worker.generate(1, media, 1000, 160, QStringLiteral("first|1"));
  QCOMPARE(failedSpy.count(), 0);
  const QImage first = decodeThumbnail(frameAtRequestedPosition(readySpy).at(2).toString());

  // Playing another video must reuse the preview player for the new stream.
  readySpy.clear();
  worker.setLatestRequest(2);
  worker.generate(2, otherMedia, 1000, 160, QStringLiteral("second|1"));
  QCOMPARE(failedSpy.count(), 0);
  const QList<QVariant> secondFrame = frameAtRequestedPosition(readySpy);
  QCOMPARE(secondFrame.at(1).toString(), QStringLiteral("second|1"));

  const QImage second = decodeThumbnail(secondFrame.at(2).toString());
  QVERIFY(!first.isNull());
  QVERIFY(!second.isNull());
  QVERIFY2(first != second, "The second video should produce its own frames");
}

void TestTrickplay::testFrameMatchesRequestedPosition()
{
  // Every second of this video is one solid colour, so the colour of the
  // captured frame shows which position was actually grabbed.
  const QString media = QFINDTESTDATA("data/trickplay-colors.mp4");
  QVERIFY2(!media.isEmpty(), "Colour test video not found");

  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);
  QSignalSpy failedSpy(&worker, &TrickplayWorker::failed);

  const struct {
    qint64 positionMs;
    char expected;
  } cases[] = {
    { 500, 'r' },  // first second is red
    { 2500, 'b' }, // third second is blue
    { 4500, 'm' }, // fifth second is magenta
  };

  int id = 0;
  for (const auto& testCase : cases) {
    ++id;
    readySpy.clear();
    worker.setLatestRequest(id);
    worker.generate(id, media, testCase.positionMs, 160, QStringLiteral("colour|%1").arg(testCase.positionMs));

    QCOMPARE(failedSpy.count(), 0);
    const QList<QVariant> args = frameAtRequestedPosition(readySpy);
    QVERIFY2(!args.isEmpty(), "No frame at the requested position was delivered");

    const QImage image = decodeThumbnail(args.at(2).toString());
    QVERIFY(!image.isNull());
    QCOMPARE(dominantColor(image.scaled(1, 1).pixelColor(0, 0)), testCase.expected);
  }
}

void TestTrickplay::testMissingMediaFails()
{
  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);
  QSignalSpy failedSpy(&worker, &TrickplayWorker::failed);

  QElapsedTimer timer;
  timer.start();

  worker.setLatestRequest(1);
  worker.generate(1, QStringLiteral("/nonexistent/trickplay-preview.mp4"), 0, 160, QStringLiteral("missing|1"));

  QCOMPARE(readySpy.count(), 0);
  QCOMPARE(failedSpy.count(), 1);
  QVERIFY2(timer.elapsed() < 5000, "A missing file should fail without stalling the preview");
}

void TestTrickplay::testKeyframeFrameArrivesFirst()
{
  // The keyframe here is a second away from the requested position, so the
  // frame at the keyframe is delivered first and the exact frame afterwards.
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);
  QSignalSpy failedSpy(&worker, &TrickplayWorker::failed);

  worker.setLatestRequest(1);
  worker.generate(1, media, 2500, 160, QStringLiteral("phases|1"));

  QCOMPARE(failedSpy.count(), 0);
  QCOMPARE(readySpy.count(), 2);
  QCOMPARE(readySpy.at(0).at(5).toBool(), false);
  QCOMPARE(readySpy.at(1).at(5).toBool(), true);

  const QImage fast = decodeThumbnail(readySpy.at(0).at(2).toString());
  const QImage exact = decodeThumbnail(readySpy.at(1).at(2).toString());
  QCOMPARE(fast.size(), QSize(160, 90));
  QCOMPARE(exact.size(), QSize(160, 90));
}

void TestTrickplay::testTempDirStaysPrivate()
{
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  TrickplayWorker worker(false, QString(), QString());
  QSignalSpy readySpy(&worker, &TrickplayWorker::ready);

  worker.setLatestRequest(1);
  worker.generate(1, media, 500, 160, QStringLiteral("private|1"));
  QVERIFY(!frameAtRequestedPosition(readySpy).isEmpty());

  const QString dir = QDir(QDir::tempPath())
                        .filePath(QStringLiteral("jellyfin-desktop-trickplay-%1")
                                    .arg(QCoreApplication::applicationPid()));

  // A capture writes a frame of the video being watched, so nobody else may
  // read it and nothing may be left behind once it has been handed over.
  const QFile::Permissions permissions = QFileInfo(dir).permissions();
  const QFile::Permissions shared = QFileDevice::ReadGroup | QFileDevice::WriteGroup
    | QFileDevice::ExeGroup | QFileDevice::ReadOther | QFileDevice::WriteOther
    | QFileDevice::ExeOther;
  QVERIFY2(!(permissions & shared), "The preview directory is readable by other users");

  QCOMPARE(QDir(dir).entryList(QDir::Files | QDir::NoDotAndDotDot), QStringList());
}

void TestTrickplay::testComponentDeliversThumbnail()
{
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  TrickplayComponent& component = TrickplayComponent::Get();
  QVERIFY(component.componentInitialize());

  QSignalSpy readySpy(&component, &TrickplayComponent::thumbnailReady);
  QSignalSpy failedSpy(&component, &TrickplayComponent::thumbnailFailed);

  // Preparing the stream ahead of the first request must not break the request.
  component.prepare(media);
  component.requestThumbnail(media, 1000, 160, QStringLiteral("component|test"));

  QTRY_VERIFY_WITH_TIMEOUT(!finalThumbnail(readySpy).isEmpty(), 15000);
  QCOMPARE(failedSpy.count(), 0);

  const QList<QVariant> args = finalThumbnail(readySpy);
  QCOMPARE(args.at(0).toString(), QStringLiteral("component|test"));
  QVERIFY(args.at(1).toString().startsWith(QStringLiteral("data:image/jpeg;base64,")));
  QCOMPARE(args.at(2).toInt(), 160);
  QCOMPARE(args.at(3).toInt(), 90);
}

QTEST_MAIN(TestTrickplay)
#include "test_trickplay.moc"
