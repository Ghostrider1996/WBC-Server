const axios = require("axios");

const WOWHEAD_FOREVER_RSS = "https://www.wowhead.com/news/rss/forever";
const WOWHEAD_NEWS_URL = "https://www.wowhead.com/forever/news";
const CACHE_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 3;
const MAX_BLURB = 280;

let cache = {
  items: null,
  fetchedAt: 0,
};

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function attributeValue(block, tag, attribute) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]+)"`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function stripHtml(value) {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/Continue reading\s*»?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDisplayDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function trimBlurb(text) {
  if (text.length <= MAX_BLURB) return text;
  return `${text.slice(0, MAX_BLURB).replace(/\s+\S*$/, "").trim()}...`;
}

function parseRssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    const title = tagValue(block, "title");
    const url = tagValue(block, "link");
    const guid = tagValue(block, "guid") || url;
    const publishedAt = tagValue(block, "pubDate");
    const image = attributeValue(block, "media:content", "url");
    const body = trimBlurb(stripHtml(tagValue(block, "description")));

    return {
      id: guid,
      title,
      url,
      image,
      body,
      tag: "Wowhead",
      author: "Wowhead",
      date: formatDisplayDate(publishedAt),
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    };
  }).filter((item) => item.title && item.url);
}

async function fetchWowheadNews(limit = DEFAULT_LIMIT) {
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 12) : DEFAULT_LIMIT;

  if (cache.items && Date.now() - cache.fetchedAt < CACHE_MS) {
    return cache.items.slice(0, size);
  }

  try {
    const response = await axios.get(WOWHEAD_FOREVER_RSS, {
      timeout: 10000,
      responseType: "text",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": "WeekendBlastCollective/1.0 (+https://www.wbchq.com)",
      },
    });

    const items = parseRssItems(String(response.data || ""));
    if (!items.length) {
      const error = new Error("Wowhead news could not be parsed.");
      error.statusCode = 502;
      throw error;
    }

    cache = { items, fetchedAt: Date.now() };
    return items.slice(0, size);
  } catch (error) {
    if (cache.items) {
      return cache.items.slice(0, size);
    }

    if (!error.statusCode) {
      error.statusCode = 502;
    }
    throw error;
  }
}

module.exports = {
  WOWHEAD_NEWS_URL,
  fetchWowheadNews,
};
