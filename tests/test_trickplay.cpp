#include <QtTest/QtTest>

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
  QCOMPARE(readySpy.count(), 1);

  const QList<QVariant> args = readySpy.takeFirst();
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
  QCOMPARE(readySpy.count(), 1);
  const QString first = readySpy.at(0).at(2).toString();

  worker.setLatestRequest(2);
  worker.generate(2, media, 2500, 160, QStringLiteral("item|second"));
  QCOMPARE(failedSpy.count(), 0);
  QCOMPARE(readySpy.count(), 2);
  const QString second = readySpy.at(1).at(2).toString();

  QVERIFY2(first != second, "Different positions should produce different frames");

  // A cached key is answered from memory and yields the exact same frame.
  worker.setLatestRequest(3);
  worker.generate(3, media, 500, 160, QStringLiteral("item|first"));
  QCOMPARE(failedSpy.count(), 0);
  QCOMPARE(readySpy.count(), 3);
  QCOMPARE(readySpy.at(2).at(2).toString(), first);
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
  QCOMPARE(readySpy.count(), 1);

  // Playing another video must reuse the preview player for the new stream.
  worker.setLatestRequest(2);
  worker.generate(2, otherMedia, 1000, 160, QStringLiteral("second|1"));
  QCOMPARE(failedSpy.count(), 0);
  QCOMPARE(readySpy.count(), 2);
  QCOMPARE(readySpy.at(1).at(1).toString(), QStringLiteral("second|1"));

  const QImage first = decodeThumbnail(readySpy.at(0).at(2).toString());
  const QImage second = decodeThumbnail(readySpy.at(1).at(2).toString());
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
    worker.setLatestRequest(id);
    worker.generate(id, media, testCase.positionMs, 160, QStringLiteral("colour|%1").arg(testCase.positionMs));

    QCOMPARE(failedSpy.count(), 0);
    QCOMPARE(readySpy.count(), 1);

    const QImage image = decodeThumbnail(readySpy.takeFirst().at(2).toString());
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

void TestTrickplay::testComponentDeliversThumbnail()
{
  const QString media = QFINDTESTDATA("data/trickplay.mp4");
  QVERIFY2(!media.isEmpty(), "Test video not found");

  TrickplayComponent& component = TrickplayComponent::Get();
  QVERIFY(component.componentInitialize());

  QSignalSpy readySpy(&component, &TrickplayComponent::thumbnailReady);
  QSignalSpy failedSpy(&component, &TrickplayComponent::thumbnailFailed);

  component.requestThumbnail(media, 1000, 160, QStringLiteral("component|test"));

  QTRY_COMPARE_WITH_TIMEOUT(readySpy.count(), 1, 15000);
  QCOMPARE(failedSpy.count(), 0);

  const QList<QVariant> args = readySpy.takeFirst();
  QCOMPARE(args.at(0).toString(), QStringLiteral("component|test"));
  QVERIFY(args.at(1).toString().startsWith(QStringLiteral("data:image/jpeg;base64,")));
  QCOMPARE(args.at(2).toInt(), 160);
  QCOMPARE(args.at(3).toInt(), 90);
}

QTEST_MAIN(TestTrickplay)
#include "test_trickplay.moc"
