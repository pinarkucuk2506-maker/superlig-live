const admin = require("firebase-admin");
const axios = require("axios");
const https = require("https");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const TFF_URL =
  "https://www.tff.org/Default.aspx?pageID=198";

const SEASON = "2026-2027";

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

function cleanTeamName(name) {
  return name
    .replace(/\s+A\.Ş\.$/i, "")
    .replace(/\s+FK$/i, "")
    .trim();
}

function parseScore(text) {
  const value = text.replace(/\s+/g, " ").trim();

  const match = value.match(/^(\d+)\s*-\s*(\d+)$/);

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

async function fetchTffHtml() {
  console.log("TFF sayfası indiriliyor...");

  // TFF sunucusunun sertifika zinciri GitHub Runner
  // tarafından doğrulanamıyor.
  // Bu istisna yalnızca TFF bağlantısı için kullanılıyor.
  const tffAgent = new https.Agent({
    rejectUnauthorized: false,
  });

  const response = await axios.get(TFF_URL, {
    responseType: "arraybuffer",
    timeout: 30000,

    httpsAgent: tffAgent,

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",

      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  console.log("HTTP:", response.status);
  console.log("HTML byte:", response.data.length);

  const html = iconv.decode(
    Buffer.from(response.data),
    "windows-1254"
  );

  // Yanlış bir sayfa gelmesini engellemek için
  // TFF sayfasının temel işaretlerini kontrol ediyoruz.
  if (
    !html.includes("2026-2027") ||
    !html.includes("macId=")
  ) {
    throw new Error(
      "TFF'den beklenen Süper Lig HTML'i alınamadı."
    );
  }

  return html;
}

function parseFixtures(html) {
  const $ = cheerio.load(html);

  const matches = [];

  const fixtureTable = $("table.fiksturListesiTable").first();

  if (!fixtureTable.length) {
    throw new Error(
      "TFF fiksturListesiTable bulunamadı."
    );
  }

  fixtureTable
    .find("table.softBG")
    .each((_, weekTable) => {

      const weekText = $(weekTable)
        .find("td.belirginYazi")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const weekMatch =
        weekText.match(/(\d+)\s*\.\s*Hafta/i);

      if (!weekMatch) {
        return;
      }

      const week = Number(weekMatch[1]);

      $(weekTable)
        .find("tr")
        .each((_, row) => {

          const cells = $(row).children("td");

          if (cells.length !== 3) {
            return;
          }

          const homeAnchor =
            $(cells[0]).find("a").first();

          const scoreAnchor =
            $(cells[1]).find("a").first();

          const awayAnchor =
            $(cells[2]).find("a").first();

          if (
            !homeAnchor.length ||
            !scoreAnchor.length ||
            !awayAnchor.length
          ) {
            return;
          }

          const homeTeam = cleanTeamName(
            homeAnchor.text()
              .replace(/\s+/g, " ")
              .trim()
          );

          const awayTeam = cleanTeamName(
            awayAnchor.text()
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

          const matchId = macIdMatch[1];

          const score = parseScore(
            scoreAnchor.text()
          );

          if (
            !matches.some(
              (m) => m.matchId === matchId
            )
          ) {
            matches.push({
              matchId,

              season: SEASON,
              week,

              homeTeam: slugify(homeTeam),
              awayTeam: slugify(awayTeam),

              homeTeamName: homeTeam,
              awayTeamName: awayTeam,

              homeScore: score.homeScore,
              awayScore: score.awayScore,

              status: score.status,

              source: "TFF",
            });
          }
        });
    });

  return matches;
}

function createStandings(matches) {
  const teams = new Map();

  function ensureTeam(slug, name) {
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

  for (const match of matches) {

    ensureTeam(
      match.homeTeam,
      match.homeTeamName
    );

    ensureTeam(
      match.awayTeam,
      match.awayTeamName
    );

    if (
      match.status !== "finished" ||
      match.homeScore === null ||
      match.awayScore === null
    ) {
      continue;
    }

    const home = teams.get(
      match.homeTeam
    );

    const away = teams.get(
      match.awayTeam
    );

    home.played++;
    away.played++;

    home.goalsFor += match.homeScore;
    home.goalsAgainst += match.awayScore;

    away.goalsFor += match.awayScore;
    away.goalsAgainst += match.homeScore;

    if (match.homeScore > match.awayScore) {
      home.wins++;
      home.points += 3;

      away.losses++;
    }
    else if (
      match.homeScore < match.awayScore
    ) {
      away.wins++;
      away.points += 3;

      home.losses++;
    }
    else {
      home.draws++;
      away.draws++;

      home.points++;
      away.points++;
    }
  }

  const standings = [];

  for (const [slug, data] of teams) {
    data.goalDifference =
      data.goalsFor - data.goalsAgainst;

    standings.push({
      slug,
      ...data,
    });
  }

  standings.sort((a, b) => {
    if (b.points !== a.points) {
      return b.points - a.points;
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

    return (
      b.goalsFor -
      a.goalsFor
    );
  });

  standings.forEach(
    (team, index) => {
      team.rank = index + 1;
    }
  );

  return standings;
}

async function saveMatches(db, matches) {
  console.log(
    `Firestore'a ${matches.length} maç yazılıyor...`
  );

  for (
    let i = 0;
    i < matches.length;
    i += 400
  ) {
    const chunk =
      matches.slice(i, i + 400);

    const batch = db.batch();

    for (const match of chunk) {

      const ref = db
        .collection("matches")
        .doc(match.matchId);

      batch.set(
        ref,
        {
          season: match.season,
          week: match.week,

          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,

          homeTeamName:
            match.homeTeamName,
          awayTeamName:
            match.awayTeamName,

          homeScore:
            match.homeScore,
          awayScore:
            match.awayScore,

          status: match.status,

          source: "TFF",

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),
        },
        { merge: true }
      );
    }

    await batch.commit();
  }
}

async function saveTeams(db, matches) {
  const teams = new Map();

  for (const match of matches) {
    teams.set(
      match.homeTeam,
      match.homeTeamName
    );

    teams.set(
      match.awayTeam,
      match.awayTeamName
    );
  }

  const batch = db.batch();

  for (
    const [slug, name] of teams
  ) {
    const ref = db
      .collection("teams")
      .doc(slug);

    batch.set(
      ref,
      {
        name,
        shortName: slug
          .split("-")
          .map(
            part =>
              part
                .charAt(0)
                .toUpperCase()
          )
          .join("")
          .slice(0, 4),

        slug,

        season: SEASON,

        updatedAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),
      },
      { merge: true }
    );
  }

  await batch.commit();

  console.log(
    `Takım sayısı: ${teams.size}`
  );
}

async function saveStandings(db, standings) {
  console.log(
    `Puan cetveli: ${standings.length} takım`
  );

  for (
    let i = 0;
    i < standings.length;
    i += 400
  ) {
    const chunk =
      standings.slice(i, i + 400);

    const batch = db.batch();

    for (const team of chunk) {

      const ref = db
        .collection("standings")
        .doc(team.slug);

      batch.set(
        ref,
        {
          teamName:
            team.teamName,

          rank: team.rank,

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

          season: SEASON,

          updatedAt:
            admin.firestore
              .FieldValue
              .serverTimestamp(),
        },
        { merge: true }
      );
    }

    await batch.commit();
  }
}

async function main() {
  if (
    !process.env.FIREBASE_SERVICE_ACCOUNT
  ) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT secret bulunamadı."
    );
  }

  const serviceAccount =
    JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

  admin.initializeApp({
    credential:
      admin.credential.cert(
        serviceAccount
      ),
  });

  const db =
    admin.firestore();

  const html =
    await fetchTffHtml();

  const matches =
    parseFixtures(html);

  console.log(
    `Bulunan maç: ${matches.length}`
  );

  if (matches.length !== 306) {
    throw new Error(
      `Beklenen 306 maç yerine ${matches.length} maç bulundu.`
    );
  }

  const standings =
    createStandings(matches);

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

  await db
    .collection("settings")
    .doc("season")
    .set(
      {
        currentSeason: SEASON,
        matchCount:
          matches.length,
        lastSyncAt:
          admin.firestore
            .FieldValue
            .serverTimestamp(),
      },
      { merge: true }
    );

  console.log("");
  console.log(
    "✅ TFF SENKRONİZASYONU TAMAMLANDI"
  );
}

main().catch(
  (error) => {
    console.error("");
    console.error(
      "❌ SENKRONİZASYON HATASI"
    );
    console.error(error);
    process.exitCode = 1;
  }
);