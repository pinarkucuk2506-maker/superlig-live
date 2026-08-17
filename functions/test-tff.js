const fs = require("fs");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const FILE = "./tff.html";
const SEASON = "2026-2027";

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, code) =>
            String.fromCharCode(Number(code))
        )
        .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
            String.fromCharCode(parseInt(code, 16))
        );
}

function cleanText(text) {
    return decodeEntities(text)
        .replace(/\s+/g, " ")
        .trim();
}

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
    const match = text
        .replace(/\s+/g, " ")
        .trim()
        .match(/^(\d+)\s*-\s*(\d+)$/);

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

/*
 * Chrome'un "View Source" ekranından kaydedilmiş HTML'yi
 * gerçek kaynak HTML'ye dönüştürüyoruz.
 */
function reconstructOriginalHtml() {
    const buffer = fs.readFileSync(FILE);

    // Dosyada windows-1254 işareti olduğundan önce bunu deniyoruz.
    const page = iconv.decode(buffer, "windows-1254");

    const $ = cheerio.load(page);

    const sourceLines = [];

    $("td.line-content").each((_, element) => {
        sourceLines.push($(element).text());
    });

    if (sourceLines.length > 0) {
        console.log(
            "Chrome kaynak görüntüleyicisi algılandı."
        );

        console.log(
            "Kaynak satırı:",
            sourceLines.length
        );

        return decodeEntities(sourceLines.join("\n"));
    }

    console.log(
        "Chrome kaynak görüntüleyicisi bulunamadı; dosya doğrudan kaynak kabul ediliyor."
    );

    return page;
}

function parseMatches(html) {

    const $ = cheerio.load(html);

    const matches = [];

    let currentWeek = null;

    /*
     * Fikstür tablolarındaki tüm satırları dolaşıyoruz.
     */
    $("tr").each((_, row) => {

        const text = $(row)
            .text()
            .replace(/\s+/g, " ")
            .trim();

        // Hafta başlığını yakala.
        const weekMatch = text.match(
            /^(\d+)\s*\.\s*Hafta$/i
        );

        if (weekMatch) {
            currentWeek = Number(weekMatch[1]);
            return;
        }

        if (!currentWeek) {
            return;
        }

        const cells = $(row).children("td");

        if (cells.length !== 3) {
            return;
        }

        const homeAnchor = $(cells[0]).find("a").first();
        const scoreAnchor = $(cells[1]).find("a").first();
        const awayAnchor = $(cells[2]).find("a").first();

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

        const scoreText = scoreAnchor.text()
            .replace(/\s+/g, " ")
            .trim();

        const href = scoreAnchor.attr("href") || "";

        const macIdMatch = href.match(
            /macId=(\d+)/i
        );

        if (!macIdMatch) {
            return;
        }

        const macId = macIdMatch[1];

        const score = parseScore(scoreText);

        const match = {
            matchId: macId,

            season: SEASON,
            week: currentWeek,

            homeTeam: slugify(homeTeam),
            awayTeam: slugify(awayTeam),

            homeTeamName: homeTeam,
            awayTeamName: awayTeam,

            homeScore: score.homeScore,
            awayScore: score.awayScore,

            status: score.status,

            source: "TFF",
        };

        if (
            !matches.some(
                item => item.matchId === match.matchId
            )
        ) {
            matches.push(match);
        }
    });

    return matches;
}

function main() {

    console.log("TFF HTML okunuyor...");
    console.log("");

    const html = reconstructOriginalHtml();

    console.log(
        "Oluşturulan gerçek HTML uzunluğu:",
        html.length
    );

    console.log("");

    console.log(
        "1.Hafta:",
        /1\s*\.\s*Hafta/i.test(html)
    );

    console.log(
        "macId:",
        /macId=\d+/i.test(html)
    );

    console.log("");

    const matches = parseMatches(html);

    console.log("====================================");
    console.log("PARSER SONUCU");
    console.log("====================================");

    console.log(
        "Toplam maç:",
        matches.length
    );

    console.log("");

    if (matches.length > 0) {

        console.log("İlk 10 maç:");
        console.table(
            matches.slice(0, 10)
        );

        console.log("");

        const weekCounts = {};

        for (const match of matches) {
            weekCounts[match.week] =
                (weekCounts[match.week] || 0) + 1;
        }

        console.log(
            "Hafta başına maç:"
        );

        console.table(weekCounts);

        console.log("");

        const finished = matches.filter(
            m => m.status === "finished"
        ).length;

        const scheduled = matches.filter(
            m => m.status === "scheduled"
        ).length;

        console.log(
            "Oynanmış:",
            finished
        );

        console.log(
            "Oynanmamış:",
            scheduled
        );

        console.log("");

        if (matches.length === 306) {
            console.log(
                "✅ BAŞARILI: 306 maç bulundu."
            );
        } else {
            console.log(
                `⚠️ ${matches.length} maç bulundu.`
            );
        }

    } else {

        console.log(
            "❌ Maç bulunamadı."
        );
    }
}

try {
    main();
} catch (error) {
    console.error("");
    console.error(
        "❌ TEST HATASI"
    );
    console.error(error);
    process.exitCode = 1;
}