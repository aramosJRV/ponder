// Parses the `world-english-bible` npm package JSON into flat verse rows.
// The package encodes each book as an array of chunks; verse text is the
// concatenation of 'paragraph text' and 'line text' chunks sharing the
// same chapterNumber/verseNumber, in order.

import { createRequire } from 'node:module';
import { BOOKS } from './books.mjs';

const require = createRequire(import.meta.url);

const TEXT_TYPES = new Set(['paragraph text', 'line text']);

/** @returns {{ book_number:number, book:string, chapter:number, verse:number, text:string }[]} */
export function parseBook(bookMeta) {
  const chunks = require(`world-english-bible/json/${bookMeta.file}.json`);
  const verses = new Map(); // 'chapter:verse' -> string[]

  for (const chunk of chunks) {
    if (!TEXT_TYPES.has(chunk.type)) continue;
    if (chunk.chapterNumber == null || chunk.verseNumber == null) continue;
    const key = `${chunk.chapterNumber}:${chunk.verseNumber}`;
    if (!verses.has(key)) verses.set(key, []);
    verses.get(key).push(chunk.value);
  }

  const rows = [];
  for (const [key, parts] of verses) {
    const [chapter, verse] = key.split(':').map(Number);
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    rows.push({
      book_number: bookMeta.n,
      book: bookMeta.name,
      chapter,
      verse,
      text,
    });
  }

  rows.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  return rows;
}

/** All 66 books, plus per-book chapter counts for bible_books. */
export function parseAll() {
  const allRows = [];
  const bookRows = [];

  for (const meta of BOOKS) {
    const rows = parseBook(meta);
    if (rows.length === 0) throw new Error(`No verses parsed for ${meta.name}`);
    allRows.push(...rows);
    bookRows.push({
      book_number: meta.n,
      name: meta.name,
      aliases: meta.aliases,
      testament: meta.testament,
      chapter_count: Math.max(...rows.map((r) => r.chapter)),
    });
  }

  return { verses: allRows, books: bookRows };
}
