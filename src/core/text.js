const STOPWORDS = new Set(["the", "and", "for", "with", "this", "that"]);

function tokenize(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9_\-一-鿿]+/g) || [])]
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

module.exports = { tokenize };
