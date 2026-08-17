const { onRequest } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const axios = require("axios");
const cheerio = require("cheerio");

admin.initializeApp();

const db = getFirestore();

const TFF_URL =
  "https://www.tff.org/Default.aspx?macId=283710&pageId=198";

const SEASON = "2026-2027";

/**
 * Türkçe/TFF takım adlarını uygulamada kullanacağımız
 * sade slug değerlerine dönüştürür.
 */
function createSlug(name) {
  return name
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * TFF'nin takım adındaki şirket/unvan eklerini temizler.
 */
function cleanTeamName(name) {
  return name
    .replace(/\s+A\.Ş\.$/i, "")
    .replace(/\s+FK$/i, "")
    .replace(/\s+SPORTİF FAALİYETLER$/i, "")
    .trim();
}

/**
 * TFF fikstür sayfasını okuyup maçları çıkarır.
 */
async function fetchFixturesFromTff() {
  const response = await axios.get(TFF_URL, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const $ = cheerio.load(response.data);
  const matches = [];

  let currentWeek = null;

  $("body")
    .find("*")
    .each((_, element) => {
      const text = $(element)
        .clone()
        .children()
        .remove()
        .end()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const weekMatch = text.match(/^(\d{1,2})\.Hafta$/i);

      if (weekMatch) {
        currentWeek = Number(weekMatch[1]);
        return;
      }

      if (!currentWeek) {
        return;
      }

      if (!text.includes(" - ")) {
        return;
      }

      const parts = text.split(" - ");

      if (parts.length !== 2) {
        return;
      }

      const homeTeam = cleanTeamName(parts[0]);
      const awayTeam = cleanTeamName(parts[1]);

      if (!homeTeam || !awayTeam) {
        return;
      }

      // Bazı HTML elemanları aynı metni tekrar üretebilir.
      const duplicate = matches.some(
        (m) =>
          m.week === currentWeek &&
          m.homeTeam === homeTeam &&
          m.awayTeam === awayTeam
      );

      if (duplicate) {
        return;
      }

      matches.push({
        season: SEASON,
        week: currentWeek,
        homeTeam,
        awayTeam,
        homeTeamSlug: createSlug(homeTeam),
        awayTeamSlug: createSlug(awayTeam),
      });
    });

  return matches;
}

/**
 * TFF'den fikstürü alır ve Firestore matches collection'ına yazar.
 */
exports.syncSuperLig = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (req, res) => {
    try {
      console.log("TFF fikstürü okunuyor...");

      const matches = await fetchFixturesFromTff();

      console.log(`Bulunan maç sayısı: ${matches.length}`);

      if (matches.length === 0) {
        throw new Error(
          "TFF sayfasından maç bulunamadı. Sayfanın HTML yapısı değişmiş olabilir."
        );
      }

      const batch = db.batch();

      for (const match of matches) {
        const matchId =
          `${SEASON}_${String(match.week).padStart(2, "0")}_` +
          `${match.homeTeamSlug}_${match.awayTeamSlug}`;

        const ref = db.collection("matches").doc(matchId);

        batch.set(
          ref,
          {
            season: match.season,
            week: match.week,
            homeTeam: match.homeTeamSlug,
            awayTeam: match.awayTeamSlug,
            homeTeamName: match.homeTeam,
            awayTeamName: match.awayTeam,

            homeScore: 0,
            awayScore: 0,
            status: "scheduled",

            source: "TFF",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      await batch.commit();

      await db.collection("settings").doc("season").set(
        {
          currentSeason: SEASON,
          lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          matchCount: matches.length,
        },
        { merge: true }
      );

      res.status(200).json({
        success: true,
        season: SEASON,
        matchCount: matches.length,
      });
    } catch (error) {
      console.error("syncSuperLig error:", error);

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);