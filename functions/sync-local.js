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