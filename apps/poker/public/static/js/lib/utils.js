class ReferenceStore {  constructor() { this.counts = new Map(); }
  add(item) { 
    if (!item) return; 
    const val = item.trim(); 
    if (!val) return; 
    const count = this.counts.get(val) || 0;
    // Delete and re-set to move to the end of insertion order (most recent)
    if (this.counts.has(val)) this.counts.delete(val);
    this.counts.set(val, count + 1); 
  }
  remove(item) { 
    if (!item) return; 
    const val = item.trim(); 
    if (!val || !this.counts.has(val)) return; 
    const c = this.counts.get(val); 
    if (c <= 1) this.counts.delete(val); 
    else {
      // Keep position but decrement count
      this.counts.set(val, c - 1); 
    }
  }
  has(item) { return item && this.counts.has(item.trim()); }
  getCount(item) { return item ? (this.counts.get(item.trim()) || 0) : 0; }
  getItems() { 
    // Return newest items first
    return Array.from(this.counts.keys()).reverse(); 
  }
}
const usernamePool = new ReferenceStore();

function damerauLevenshtein(a, b) {
  const h = a.length, w = b.length;
  const matrix = Array.from({ length: h + 1 }, () => new Array(w + 1).fill(0));
  for (let i = 0; i <= h; i++) matrix[i][0] = i;
  for (let j = 0; j <= w; j++) matrix[0][j] = j;

  for (let i = 1; i <= h; i++) {
    for (let j = 1; j <= w; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return matrix[h][w];
}

function isSubsequence(sub, str) {
  let i = 0, j = 0;
  while (i < sub.length && j < str.length) {
    if (sub[i] === str[j]) i++;
    j++;
  }
  return i === sub.length;
}