const fs = require("fs");
const admin = require("firebase-admin");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const SEASON = "2026-2027";
const TFF_FILE = "./tff-live.html";

/* ---------------------------------------------------------
   TAKIM İSMİ -> SLUG
--------------------------------------------------------- */

function slugify(name) {
  return name
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ---------------------------------------------------------
   TAKIM ADINI TEMİZLE
--------------------------------------------------------- */

function cleanTeamName(name) {
  return name
    .replace(/\s+A\.Ş\.$/i, "")
    .replace(/\s+FK$/i, "")
    .replace(/\s+SK$/i, "")
    .trim();
}

/* ---------------------------------------------------------
   SKORU AYIR
--------------------------------------------------------- */

function parseScore(text) {
  const value = text
    .replace(/\s+/g, " ")
    .trim();

  const match = value.match(
    /^(\d+)\s*-\s*(\d+)$/
  );

  if (!match) {
    return {
      homeScore: null,
      awayScore: null,
      status: "scheduled",
    };
  }

  return {
    homeScore: Number(match[1]),
    awayScore: Number(match[2]),
    status: "finished",
  };
}

/* ---------------------------------------------------------
   TFF HTML DOSYASINI OKU
--------------------------------------------------------- */

function fetchTffHtml() {
  console.log("TFF HTML dosyası okunuyor...");
  console.log(`Dosya: ${TFF_FILE}`);

  if (!fs.existsSync(TFF_FILE)) {
    throw new Error(
      `TFF HTML dosyası bulunamadı: ${TFF_FILE}`
    );
  }

  const buffer = fs.readFileSync(TFF_FILE);

  console.log(
    `TFF HTML byte: ${buffer.length}`
  );

  /*
   * TFF sayfası Windows-1254 kullanıyor.
   */
  const html = iconv.decode(
    buffer,
    "windows-1254"
  );

  console.log(
    `TFF HTML karakter: ${html.length}`
  );

  /*
   * Yanlış sayfa indirilmesini önle.
   */
  if (!html.includes("2026-2027")) {
    throw new Error(
      "TFF HTML içinde 2026-2027 sezonu bulunamadı."
    );
  }

  if (!html.includes("macId=")) {
    throw new Error(
      "TFF HTML içinde macId bulunamadı."
    );
  }

  return html;
}

/* ---------------------------------------------------------
   FİKSTÜRÜ PARSE ET
--------------------------------------------------------- */

function parseFixtures(html) {
  const $ = cheerio.load(html);

  const matches = [];

  const fixtureTable = $(
    "table.fiksturListesiTable"
  ).first();

  if (!fixtureTable.length) {
    throw new Error(
      "TFF fiksturListesiTable bulunamadı."
    );
  }

  /*
   * Her softBG tablo bir haftayı temsil ediyor.
   */
  fixtureTable
    .find("table.softBG")
    .each((_, weekTable) => {
      const weekText = $(weekTable)
        .find("td.belirginYazi")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const weekMatch = weekText.match(
        /(\d+)\s*\.\s*Hafta/i
      );

      if (!weekMatch) {
        return;
      }

      const week = Number(
        weekMatch[1]
      );

      /*
       * Bu haftanın maçlarını bul.
       */
      $(weekTable)
        .find("tr")
        .each((_, row) => {
          const cells =
            $(row).children("td");

          if (cells.length !== 3) {
            return;
          }

          const homeAnchor =
            $(cells[0])
              .find("a")
              .first();

          const scoreAnchor =
            $(cells[1])
              .find("a")
              .first();

          const awayAnchor =
            $(cells[2])
              .find("a")
              .first();

          if (
            !homeAnchor.length ||
            !scoreAnchor.length ||
            !awayAnchor.length
          ) {
            return;
          }

          const homeTeamName =
            cleanTeamName(
              homeAnchor
                .text()
                .replace(/\s+/g, " ")
                .trim()
            );

          const awayTeamName =
            cleanTeamName(
              awayAnchor
                .text()
                .replace(/\s+/g, " ")
                .trim()
            );

          const href =
            scoreAnchor.attr("href") || "";

          const macIdMatch =
            href.match(/macId=(\d+)/i);

          if (!macIdMatch) {
            return;
          }

          const matchId =
            macIdMatch[1];

          const score =
            parseScore(
              scoreAnchor.text()
            );

          /*
           * Aynı maç birden fazla yerde bulunursa
           * sadece bir kez ekle.
           */
          if (
            matches.some(
              (item) =>
                item.matchId === matchId
            )
          ) {
            return;
          }

          matches.push({
            matchId,

            season: SEASON,
            week,

            homeTeam:
              slugify(homeTeamName),

            awayTeam:
              slugify(awayTeamName),

            homeTeamName,
            awayTeamName,

            homeScore:
              score.homeScore,

            awayScore:
              score.awayScore,

            status:
              score.status,

            source: "TFF",
          });
        });
    });

  return matches;
}

/* ---------------------------------------------------------
   TFF MAÇ DETAYI: TARİH / SAAT / HAKEM / STADYUM
--------------------------------------------------------- */

const TFF_DETAIL_BASE = "https://www.tff.org/Default.aspx?pageID=29&macId=";
const DETAIL_CONCURRENCY = 2;
const DETAIL_RETRIES = 3;

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchMatchDetails(matchId) {
  const url = `${TFF_DETAIL_BASE}${encodeURIComponent(matchId)}`;
  let response = null;
  let lastError = null;

  // TFF bağlantısı geçici olarak başarısız olursa artan bekleme süresiyle yeniden dene.
  for (let attempt = 1; attempt <= DETAIL_RETRIES; attempt++) {
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
          "Referer": "https://www.tff.org/Default.aspx?pageID=198",
        },
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${matchId})`);
      }
      break;
    } catch (error) {
      lastError = error;
      if (attempt < DETAIL_RETRIES) {
        const delayMs = 1000 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  if (!response || !response.ok) {
    throw lastError || new Error(`TFF detay sayfası alınamadı (${matchId})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const html = iconv.decode(buffer, "windows-1254");
  const $ = cheerio.load(html);
  const bodyHtml = $("body").html() || html;
  const textWithLines = bodyHtml
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr|td|h[1-6]|table|section|article)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = textWithLines
    .replace(/\r/g, "\n")
    .split("\n")
    .map(cleanText)
    .filter(Boolean);
  const allText = cleanText(lines.join(" "));

  const dateMatch = allText.match(/\b(\d{2}\.\d{2}\.\d{4})\s*[-–]\s*(\d{1,2}:\d{2})\b/);
  const details = {
    matchDate: dateMatch ? dateMatch[1] : null,
    matchTime: dateMatch ? dateMatch[2] : null,
    referee: null,
    stadium: null,
  };

  // Hakem satırını doğrudan metin düğümünden bul; isim tahmin etme.
  const refereeNode = $("body").find("*").contents().filter(function () {
    return this.type === "text" && /\(\s*Hakem\s*\)/i.test(this.data || "");
  }).first();
  if (refereeNode.length) {
    details.referee = cleanText(refereeNode.text())
      .replace(/\s*\(\s*Hakem\s*\)/i, "") || null;
  } else {
    const refereeMatch = allText.match(/([\p{L}.'’-]+(?:\s+[\p{L}.'’-]+){1,4})\s*\(\s*Hakem\s*\)/iu);
    if (refereeMatch) details.referee = cleanText(refereeMatch[1]);
  }

  // Tarih satırından hemen önceki uygun satır genellikle stadyum/şehir bilgisidir.
  const dateLineIndex = lines.findIndex((line) => /\b\d{2}\.\d{2}\.\d{4}\s*[-–]\s*\d{1,2}:\d{2}\b/.test(line));
  if (dateLineIndex > 0) {
    const candidate = lines[dateLineIndex - 1];
    if (candidate.length >= 5 && !/^(maç kodu|trendyol süper lig|hakem)$/i.test(candidate)) {
      details.stadium = candidate.replace(/^⚑\s*/, "").trim() || null;
    }
  }

  return details;
}

async function enrichMatchDetails(db, matches) {
  console.log("Mevcut maç detayları kontrol ediliyor...");
  const existingSnapshot = await db.collection("matches")
    .where("season", "==", SEASON)
    .get();
  const existingById = new Map();
  existingSnapshot.forEach((doc) => existingById.set(doc.id, doc.data()));

  const DETAIL_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  const pending = matches.filter((match) => {
    const old = existingById.get(match.matchId) || {};
    match.matchDate = old.matchDate || null;
    match.matchTime = old.matchTime || null;
    match.referee = old.referee || null;
    match.stadium = old.stadium || null;
    match.detailsCheckedAt = old.detailsCheckedAt || null;

    // Tarih/saat/hakem/stadyumdan biri eksik olabilir; ancak TFF her bilgiyi
    // aynı anda açıklamaz. Aynı eksik maçları her 15 dakikada yeniden indirme.
    if (match.matchDate && match.matchTime && match.referee && match.stadium) {
      return false;
    }

    const checkedAt = old.detailsCheckedAt;
    let checkedAtMs = 0;
    if (checkedAt && typeof checkedAt.toDate === "function") {
      checkedAtMs = checkedAt.toDate().getTime();
    } else if (checkedAt instanceof Date) {
      checkedAtMs = checkedAt.getTime();
    } else if (typeof checkedAt === "number") {
      checkedAtMs = checkedAt;
    }

    return !checkedAtMs || (nowMs - checkedAtMs) >= DETAIL_RECHECK_INTERVAL_MS;
  });

  console.log(`Detay bilgisi eksik maç: ${pending.length}`);
  let nextIndex = 0;
  let successCount = 0;
  let failCount = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= pending.length) return;
      const match = pending[index];
      try {
        const details = await fetchMatchDetails(match.matchId);
        for (const key of ["matchDate", "matchTime", "referee", "stadium"]) {
          if (details[key]) match[key] = details[key];
        }
        if (details.matchDate || details.matchTime || details.referee || details.stadium) successCount++;
        else failCount++;
      } catch (error) {
        failCount++;
        console.warn(`Maç detayı alınamadı (${match.matchId}): ${error.message}`);
      } finally {
        // Başarılı/başarısız her kontrolü kaydet; eksik bilgi varsa 24 saat sonra tekrar dene.
        match.detailsCheckedAt = new Date();
      }
      // TFF sunucusuna yük bindirmemek ve geçici bağlantı hatalarını azaltmak için bekle.
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, () => worker()));
  console.log(`Detay sayfası okunan maç: ${successCount}; eksik/başarısız: ${failCount}`);
  return matches;
}

/* ---------------------------------------------------------
   PUAN CETVELİ OLUŞTUR
--------------------------------------------------------- */

function createStandings(matches) {
  const teams = new Map();

  function ensureTeam(
    slug,
    name
  ) {
    if (!teams.has(slug)) {
      teams.set(slug, {
        teamName: name,

        played: 0,

        wins: 0,
        draws: 0,
        losses: 0,

        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,

        points: 0,
      });
    }

    return teams.get(slug);
  }

  /*
   * Önce bütün takımları oluştur.
   */
  for (const match of matches) {
    ensureTeam(
      match.homeTeam,
      match.homeTeamName
    );

    ensureTeam(
      match.awayTeam,
      match.awayTeamName
    );
  }

  /*
   * Sadece oynanmış maçları hesapla.
   */
  for (const match of matches) {
    if (
      match.status !==
        "finished" ||
      match.homeScore === null ||
      match.awayScore === null
    ) {
      continue;
    }

    const home =
      teams.get(
        match.homeTeam
      );

    const away =
      teams.get(
        match.awayTeam
      );

    home.played += 1;
    away.played += 1;

    home.goalsFor +=
      match.homeScore;

    home.goalsAgainst +=
      match.awayScore;

    away.goalsFor +=
      match.awayScore;

    away.goalsAgainst +=
      match.homeScore;

    /*
     * Ev sahibi kazandı.
     */
    if (
      match.homeScore >
      match.awayScore
    ) {
      home.wins += 1;
      home.points += 3;

      away.losses += 1;
    }

    /*
     * Deplasman kazandı.
     */
    else if (
      match.homeScore <
      match.awayScore
    ) {
      away.wins += 1;
      away.points += 3;

      home.losses += 1;
    }

    /*
     * Beraberlik.
     */
    else {
      home.draws += 1;
      away.draws += 1;

      home.points += 1;
      away.points += 1;
    }
  }

  const standings = [];

  for (
    const [slug, data]
    of teams
  ) {
    data.goalDifference =
      data.goalsFor -
      data.goalsAgainst;

    standings.push({
      slug,
      ...data,
    });
  }

  /*
   * Temel sıralama:
   * 1. Puan
   * 2. Averaj
   * 3. Atılan gol
   */
  standings.sort(
    (a, b) => {
      if (
        b.points !==
        a.points
      ) {
        return (
          b.points -
          a.points
        );
      }

      if (
        b.goalDifference !==
        a.goalDifference
      ) {
        return (
          b.goalDifference -
          a.goalDifference
        );
      }

      if (
        b.goalsFor !==
        a.goalsFor
      ) {
        return (
          b.goalsFor -
          a.goalsFor
        );
      }

      return a.teamName.localeCompare(
        b.teamName,
        "tr"
      );
    }
  );

  /*
   * Sıra numarası.
   */
  standings.forEach(
    (team, index) => {
      team.rank =
        index + 1;
    }
  );

  return standings;
}

/* ---------------------------------------------------------
   MATCHES -> FIRESTORE
--------------------------------------------------------- */

async function saveMatches(
  db,
  matches
) {
  console.log(
    `Firestore'a ${matches.length} maç yazılıyor...`
  );

  /*
   * Firestore batch maksimum 500 işlem.
   * Güvenli tarafta kalmak için 400 kullanıyoruz.
   */
  for (
    let i = 0;
    i < matches.length;
    i += 400
  ) {
    const chunk =
      matches.slice(
        i,
        i + 400
      );

    const batch =
      db.batch();

    for (
      const match of chunk
    ) {
      const ref =
        db
          .collection(
            "matches"
          )
          .doc(
            match.matchId
          );

      batch.set(
        ref,
        {
          season:
            match.season,

          week:
            match.week,

          homeTeam:
            match.homeTeam,

          awayTeam:
            match.awayTeam,

          homeTeamName:
            match.homeTeamName,

          awayTeamName:
            match.awayTeamName,

          homeScore:
            match.homeScore,

          awayScore:
            match.awayScore,

          status:
            match.status,

          ...(match.matchDate ? { matchDate: match.matchDate } : {}),
          ...(match.matchTime ? { matchTime: match.matchTime } : {}),
          ...(match.referee ? { referee: match.referee } : {}),
          ...(match.stadium ? { stadium: match.stadium } : {}),
          ...(match.detailsCheckedAt ? { detailsCheckedAt: match.detailsCheckedAt } : {}),

          source:
            "TFF",

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),
        },
        {
          merge: true,
        }
      );
    }

    await batch.commit();

    console.log(
      `Maç batch tamamlandı: ${i + 1}-${Math.min(
        i + chunk.length,
        matches.length
      )}`
    );
  }
}

/* ---------------------------------------------------------
   TEAMS -> FIRESTORE
--------------------------------------------------------- */

async function saveTeams(
  db,
  matches
) {
  const teams =
    new Map();

  for (
    const match of matches
  ) {
    teams.set(
      match.homeTeam,
      match.homeTeamName
    );

    teams.set(
      match.awayTeam,
      match.awayTeamName
    );
  }

  console.log(
    `Takım sayısı: ${teams.size}`
  );

  const batch =
    db.batch();

  for (
    const [slug, name]
    of teams
  ) {
    const ref =
      db
        .collection("teams")
        .doc(slug);

    /*
     * Şimdilik slug'dan kısa isim üret.
     * Daha sonra TFF kulüp kodlarından
     * gerçek kısa isimleri kullanabiliriz.
     */
    const shortName =
      createShortName(
        name
      );

    batch.set(
      ref,
      {
        name,

        shortName,

        slug,

        season: SEASON,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),
      },
      {
        merge: true,
      }
    );
  }

  await batch.commit();
}

/* ---------------------------------------------------------
   TAKIM KISA ADI
--------------------------------------------------------- */

function createShortName(
  name
) {
  const known = {
    "GALATASARAY":
      "GS",

    "FENERBAHÇE":
      "FB",

    "BEŞİKTAŞ":
      "BJK",

    "TRABZONSPOR":
      "TS",

    "GÖZTEPE":
      "GÖZ",

    "SAMSUNSPOR":
      "SAM",

    "EYÜPSPOR":
      "EYÜP",

    "KOCAELİSPOR":
      "KMS",

    "GENÇLERBİRLİĞİ":
      "GEN",

    "KASIMPAŞA":
      "KAS",

    "ERZURUMSPOR":
      "ERZ",

    "ÇAYKUR RİZESPOR":
      "RİZE",

    "TÜMOSAN KONYASPOR":
      "KON",

    "GAZİANTEP FUTBOL KULÜBÜ":
      "GFK",

    "CORENDON ALANYASPOR":
      "ALA",

    "İSTANBUL BAŞAKŞEHİR":
      "IBFK",

    "AMED SPORTİF FAALİYETLER":
      "AMED",

    "ARCA ÇORUM":
      "ÇORUM",
  };

  if (
    known[name]
  ) {
    return known[name];
  }

  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (word) =>
        word.charAt(0)
    )
    .join("")
    .toUpperCase()
    .slice(0, 4);
}

/* ---------------------------------------------------------
   STANDINGS -> FIRESTORE
--------------------------------------------------------- */

async function saveStandings(
  db,
  standings
) {
  console.log(
    `Puan cetveli: ${standings.length} takım`
  );

  for (
    let i = 0;
    i < standings.length;
    i += 400
  ) {
    const chunk =
      standings.slice(
        i,
        i + 400
      );

    const batch =
      db.batch();

    for (
      const team of chunk
    ) {
      const ref =
        db
          .collection(
            "standings"
          )
          .doc(
            team.slug
          );

      batch.set(
        ref,
        {
          teamName:
            team.teamName,

          rank:
            team.rank,

          played:
            team.played,

          wins:
            team.wins,

          draws:
            team.draws,

          losses:
            team.losses,

          goalsFor:
            team.goalsFor,

          goalsAgainst:
            team.goalsAgainst,

          goalDifference:
            team.goalDifference,

          points:
            team.points,

          season:
            SEASON,

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),
        },
        {
          merge: true,
        }
      );
    }

    await batch.commit();
  }
}

/* ---------------------------------------------------------
   FIRESTORE
--------------------------------------------------------- */

function initializeFirebase() {
  if (
    !process.env
      .FIREBASE_SERVICE_ACCOUNT
  ) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT secret bulunamadı."
    );
  }

  let serviceAccount;

  try {
    serviceAccount =
      JSON.parse(
        process.env
          .FIREBASE_SERVICE_ACCOUNT
      );
  } catch (error) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT geçerli JSON değil."
    );
  }

  admin.initializeApp({
    credential:
      admin.credential.cert(
        serviceAccount
      ),
  });

  return admin.firestore();
}

/* ---------------------------------------------------------
   ANA PROGRAM
--------------------------------------------------------- */

async function main() {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "SUPER LIG TFF SENKRONIZASYONU"
  );
  console.log(
    "========================================"
  );
  console.log(
    `Sezon: ${SEASON}`
  );
  console.log("");

  /*
   * Firebase bağlantısı.
   */
  const db =
    initializeFirebase();

  /*
   * TFF HTML dosyasını oku.
   */
  const html =
    fetchTffHtml();

  /*
   * Maçları parse et.
   */
  const matches =
    parseFixtures(html);

  console.log("");
  console.log(
    `Bulunan maç: ${matches.length}`
  );

  /*
   * 18 takım x 17 rakip =
   * 306 maç.
   *
   * Eksik veri varsa Firestore'a
   * yazmadan işlemi durdur.
   */
  if (
    matches.length !== 306
  ) {
    throw new Error(
      `Beklenen 306 maç yerine ${matches.length} maç bulundu. Firestore güncellenmedi.`
    );
  }

  /*
   * TFF maç detaylarından tarih, saat, hakem ve stadyum bilgilerini tamamla.
   * Firestore'da mevcut ve eksiksiz bilgiler yeniden indirilmez.
   */
  await enrichMatchDetails(db, matches);

  /*
   * Puan cetvelini hesapla.
   */
  const standings =
    createStandings(
      matches
    );

  /*
   * Firestore'a yaz.
   */
  await saveMatches(
    db,
    matches
  );

  await saveTeams(
    db,
    matches
  );

  await saveStandings(
    db,
    standings
  );

  /*
   * Sistem ayarları.
   */
  await db
    .collection("settings")
    .doc("season")
    .set(
      {
        currentSeason:
          SEASON,

        matchCount:
          matches.length,

        teamCount:
          standings.length,

        lastSyncAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),
      },
      {
        merge: true,
      }
    );

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "✅ TFF SENKRONİZASYONU TAMAMLANDI"
  );
  console.log(
    "========================================"
  );
}

/* ---------------------------------------------------------
   HATA YAKALA
--------------------------------------------------------- */

main().catch(
  (error) => {
    console.error("");
    console.error(
      "========================================"
    );
    console.error(
      "❌ SENKRONİZASYON HATASI"
    );
    console.error(
      "========================================"
    );
    console.error(
      error
    );

    process.exitCode = 1;
  }
);