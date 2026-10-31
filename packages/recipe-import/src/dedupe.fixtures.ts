// Links and what normalizeSourceUrl makes of them. One list, two readers: dedupe.test.ts checks the
// TypeScript function against it, and supabase/functions/recipe-import/normalize-sql.test.ts checks
// public.normalize_source_url (the SQL twin that fills recipes.source_url_normalized) against it,
// so the two cannot drift apart. Test data only; nothing imports this at runtime.

/** [input, normalized]. null means "not an http(s) link". Inputs contain no whitespace but the padding case. */
export const LINK_CASES: ReadonlyArray<readonly [string, string | null]> = [
  // Host and scheme
  ["https://Example.com/Recipe", "https://example.com/Recipe"],
  ["HTTPS://EXAMPLE.COM/a", "https://example.com/a"],
  ["http://example.com/a", "http://example.com/a"],
  ["http://example.com:8080/Path?Q=1", "http://example.com:8080/Path?Q=1"],
  ["https://User:Pw@Example.com/r", "https://user:pw@example.com/r"],
  ["https://Bücher.example/Rezept", "https://bücher.example/Rezept"],
  ["  https://example.com/a/  ", "https://example.com/a"],
  // Trailing slashes
  ["https://example.com", "https://example.com"],
  ["https://example.com/", "https://example.com"],
  ["https://example.com///", "https://example.com"],
  ["https://example.com/r/", "https://example.com/r"],
  ["https://example.com/r/?a=1", "https://example.com/r?a=1"],
  ["https://example.com/r%20x/", "https://example.com/r%20x"],
  // The path keeps its case
  ["https://example.com/Lemon-Chicken", "https://example.com/Lemon-Chicken"],
  ["https://example.com/lemon-chicken", "https://example.com/lemon-chicken"],
  // Fragments
  ["https://example.com/r#top", "https://example.com/r"],
  ["https://example.com/a?b=1#frag", "https://example.com/a?b=1"],
  ["https://example.com/a#frag?x=1", "https://example.com/a"],
  // Tracking parameters go, others stay in their order
  ["https://example.com/r?utm_source=a&utm_medium=b", "https://example.com/r"],
  ["https://example.com/r?fbclid=1", "https://example.com/r"],
  ["https://example.com/r?gclid=1&id=7", "https://example.com/r?id=7"],
  ["https://example.com/r?id=7&utm_campaign=x&page=2", "https://example.com/r?id=7&page=2"],
  ["https://example.com/r?UTM_Source=a", "https://example.com/r"],
  ["https://example.com/r?utm_id=1", "https://example.com/r"],
  ["https://example.com/r?utm_source", "https://example.com/r"],
  ["https://example.com/r?msclkid=1&mc_cid=2&mc_eid=3&dclid=4&igshid=5", "https://example.com/r"],
  ["https://example.com/r?ref_src=twsrc&_ga=2.1&oly_enc_id=9", "https://example.com/r"],
  ["https://www.instagram.com/reel/ABC/?igsh=xyz", "https://www.instagram.com/reel/ABC"],
  ["https://example.com/?fbclid=1", "https://example.com"],
  // A value that looks like a tracking name is not one; only the name counts
  ["https://example.com/a?x=utm_source", "https://example.com/a?x=utm_source"],
  ["https://example.com/a?utmx=1", "https://example.com/a?utmx=1"],
  // Empty parts
  ["https://example.com/r?", "https://example.com/r"],
  ["https://example.com/r?&&a=1&", "https://example.com/r?a=1"],
  ["https://example.com?a=1", "https://example.com?a=1"],
  // Not http(s) links
  ["ftp://example.com/a", null],
  ["example.com/a", null],
  ["javascript:alert(1)", null],
  ["not a link", null],
  ["", null],
];
