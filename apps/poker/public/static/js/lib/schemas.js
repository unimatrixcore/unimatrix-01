// --- Schema System ---

// --- Declarative Schema System ---

const Schemas = {
  NAME: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => /^[a-zA-Z0-9]*\.{0,3}$/.test(val) || /^Player [1-9]?$/.test(val) || "*RESERVED*".startsWith(val),
    getSuggestion: (val) => {
      if (!val) return null;
      const pool = usernamePool.getItems();
      const valLower = val.toLowerCase();
      for (const s of pool) {
        if (s.toLowerCase() === valLower && s !== val) return { suggestion: s, type: 'replace' };
        if (s.toLowerCase().startsWith(valLower) && s.length > val.length) return { suggestion: s, type: 'append' };
      }
      for (const s of pool) if (s.toLowerCase() === valLower) return null;
      if (val.length >= 2) {
        for (const s of pool) if (isSubsequence(valLower, s.toLowerCase())) return { suggestion: s, type: 'replace', isFuzzy: true };
      }
      if (val.length >= 3) {
        let best = null, minDistance = 3;
        for (const s of pool) {
          const sLower = s.toLowerCase();
          const dist = damerauLevenshtein(valLower, sLower.slice(0, val.length + 1));
          const threshold = val.length >= 6 ? 2 : 1;
          if (dist <= threshold && dist < minDistance) { minDistance = dist; best = s; }
        }
        if (best) return { suggestion: best, type: 'replace', isFuzzy: true };
      }
      if (/^[a-zA-Z0-9]+\.{1,2}$/.test(val)) return { suggestion: val.replace(/\.+$/, '...'), type: 'append' };
      return null;
    }
  },
  STATUS: {
    isPrefix: function(val) { return this.isPartial(val); },
    allowed: [...globalThis.OCR_CONTRACT.categories.status.values],
    shorthands: { "k": "Check", "c": "Call", "r": "Raise", "b": "Bet", "ai": "All-In", "ds": "Decline Straddle", "hw": "Hide Winning", "sc": "Show Cards", "st": "Straddle", "sb": "SB", "bb": "BB" },
    isPartial: function(val) {
      if (!val) return true;
      const v = val.toLowerCase();
      return Schemas.STATUS.validateReviewed(val).isValid; // Explicit transcription does not extend automatic acceptance.
    },
    getSuggestion: function(val) {
      if (!val) return null;
      const v = val.toLowerCase();
      if (this.shorthands[v]) return { suggestion: this.shorthands[v], type: 'replace' };
      for (const s of this.allowed) {
        if (s.toLowerCase() === v && s !== val) return { suggestion: s, type: 'replace' };
        if (s.toLowerCase().startsWith(v) && s.length > val.length) return { suggestion: s, type: 'append' };
      }
      for (const s of this.allowed) if (s.toLowerCase() === v) return null;
      if (val.length >= 2) {
        for (const s of this.allowed) if (isSubsequence(v, s.toLowerCase())) return { suggestion: s, type: 'replace', isFuzzy: true };
      }
      if (val.length >= 3) {
        let best = null, minDistance = 3;
        for (const s of this.allowed) {
          const sLower = s.toLowerCase();
          const dist = damerauLevenshtein(v, sLower.slice(0, val.length + 1));
          const threshold = val.length >= 6 ? 2 : 1;
          if (dist <= threshold && dist < minDistance) { minDistance = dist; best = s; }
        }
        if (best) return { suggestion: best, type: 'replace', isFuzzy: true };
      }
      return null;
    }
  },
  CARD: {
    isPrefix: function(val) { return this.isPartial(val); },
    ranks: [...globalThis.OCR_CONTRACT.categories.card.values],
    isPartial: function(val) { return !val || this.ranks.some(r => r.startsWith(val)); },
    getSuggestion: (val) => val === "1" ? { suggestion: "10", type: 'append' } : null
  },
  MONEY: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => !val || /^[GS]( \d*(\.\d?)?( B{0,2})?)?$/.test(val),
    isAtPrefix: (val) => val === "G " || val === "S ",
    getSuggestion: (val, item) => {
      const globalCur = gameCurrencyMap[item.game_id];
      if (!val && globalCur) return { suggestion: globalCur + " ", type: 'replace' };
      if (val.length === 1) {
        if ("g ".startsWith(val.toLowerCase())) return { suggestion: "G ", type: 'replace' };
        if ("s ".startsWith(val.toLowerCase())) return { suggestion: "S ", type: 'replace' };
      }
      const m = val.match(/^([GS] )?(\d+(\.\d)?)$/);
      if (m) return { suggestion: val + " BB", type: 'append' };
      const m2 = val.match(/^([GS] )?(\d+(\.\d)?)\s+B$/i);
      if (m2) return { suggestion: val.slice(0, -1) + "BB", type: 'replace' };
      return null;
    }
  },
  BANK: {
    noChips: ['G No Chips', 'S No Chips'],
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => Schemas.MONEY.isPartial(val) || "all-in".startsWith(val.toLowerCase()) || Schemas.BANK.noChips.some(label => label.toLowerCase().startsWith(val.toLowerCase())),
    isAtPrefix: (val) => Schemas.MONEY.isAtPrefix(val),
    getSuggestion: (val, item) => {
      const v = val.toLowerCase();
      const noChips = v.length > 2 && Schemas.BANK.noChips.find(label => label.toLowerCase().startsWith(v) && label !== val);
      if (noChips) return {suggestion:noChips,type:'replace'};
      if (v.length >= 2 && isSubsequence(v, "all-in") && v !== "all-in" && !v.includes(" ")) {
        return { suggestion: "All-In", type: 'replace', isFuzzy: true };
      }
      return Schemas.MONEY.getSuggestion(val, item);
    }
  },
  POT: {
    isPrefix: function(val) { return this.isPartial(val); },
    ritPrefix: "Run It Twice pause (",
    ritSuffix: " sec)",
    isPartial: function(val) {
      if (!val) return true;
      const v = val.toLowerCase();
      if (v.startsWith("p")) {
        const target = "Pot: ";
        if (target.toLowerCase().startsWith(v)) return true;
        if (val.startsWith(target)) return Schemas.MONEY.isPartial(val.slice(target.length));
        return false;
      }
      if (v.startsWith("r")) return this.ritPrefix.toLowerCase().startsWith(v) || (val.startsWith(this.ritPrefix) && /^\d*(\s*s?e?c?\)?)?$/i.test(val.slice(this.ritPrefix.length)));
      return false;
    },
    isAtPrefix: (val) => val === "Pot: " || val === "Pot: G " || val === "Pot: S ",
    getSuggestion: function(val, item) {
      const v = val.toLowerCase();
      if (v.length >= 2 && isSubsequence(v, this.ritPrefix.toLowerCase()) && !v.startsWith(this.ritPrefix.toLowerCase())) {
        return { suggestion: this.ritPrefix, type: 'replace', isFuzzy: true };
      }
      if (v.startsWith(this.ritPrefix.toLowerCase())) {
        const rest = v.slice(this.ritPrefix.length);
        const m = rest.match(/^(\d+)(.*)$/);
        if (m) {
          const num = m[1], typedSuffix = m[2].trimStart();
          if (this.ritSuffix.startsWith(typedSuffix) && typedSuffix !== this.ritSuffix) {
            return { suggestion: this.ritPrefix + num + this.ritSuffix, type: 'replace' };
          }
        }
      }
      const target = "Pot: ";
      if (val.length === 0 || (target.toLowerCase().startsWith(v) && v !== target.toLowerCase())) {
        const globalCur = gameCurrencyMap[item.game_id];
        return { suggestion: globalCur ? target + globalCur + " " : target, type: 'replace' };
      }
      if (val.startsWith(target)) {
        const body = val.slice(target.length);
        const res = Schemas.MONEY.getSuggestion(body, item);
        if (res) {
          if (res.type === 'replace') return { ...res, suggestion: target + res.suggestion };
          if (res.type === 'append') return { ...res, suggestion: val + res.suggestion.slice(body.length) };
        }
      }
      return null;
    }
  },
  SPLIT_POT: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => !val || /^([GS] \d+(\.\d)? BB\s+)*([GS]( \d*(\.\d?)?( B{0,2})?)?)?$/.test(val),
    isAtPrefix: (val) => Schemas.MONEY.isAtPrefix(val),
    getSuggestion: (val, item) => {
      const globalCur = gameCurrencyMap[item.game_id];
      if (!val && globalCur) return { suggestion: globalCur + " ", type: 'replace' };
      const parts = val.trim().split(/\s+/);
      const last = parts[parts.length - 1];
      if (/^\d+(\.\d)?$/.test(last)) return { suggestion: val.trim() + " BB", type: 'replace' };
      if (last.toLowerCase() === "b") return { suggestion: val.slice(0, -1) + "BB", type: 'replace' };
      if (last.toUpperCase() === "BB" && val.endsWith(" ") && globalCur) return { suggestion: val + globalCur + " ", type: 'replace' };
      return null;
    }
  },
  DEALER: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => !val || val === "D",
    getSuggestion: (val) => val.toLowerCase() === "d" && val !== "D" ? { suggestion: "D", type: 'replace' } : null
  }
};

// Same JSON bytes are used by persistence, model suggestions and training.
const ContractCategories = {name:'NAME',status:'STATUS',card:'CARD',dealer:'DEALER',bank:'BANK',bet:'MONEY',pot:'POT',split_pot:'SPLIT_POT',round_id:'ROUND_ID'};
const wholeFieldMatch = (pattern, value) => {
  if (typeof value !== 'string') return false;
  const match = new RegExp('^(?:' + pattern + ')$').exec(value);
  return !!match && match[0] === value;
};
const contractValid = (category, value) => {
  const rule = globalThis.OCR_CONTRACT.categories[category];
  if (!rule || typeof value !== 'string') return false;
  return rule.values ? rule.values.includes(value) : wholeFieldMatch(rule.pattern, value);
};
Schemas.ROUND_ID = {
  isPartial: value => typeof value === 'string' && /^#? *[0-9]{0,15}$/.test(value),
  isPrefix: function(value) { return this.isPartial(value); },
  getSuggestion: () => null,
};
for (const [category, name] of Object.entries(ContractCategories)) {
  Schemas[name].validate = value => {
    const isValid = contractValid(category, value);
    return {isValid,errorMsg:isValid ? null : 'Invalid ' + category.replaceAll('_',' ') + ' format'};
  };
}
// Enter confirms a human transcription; this does not extend automatic acceptance.
Schemas.STATUS.validateReviewed = value => {
  const result = Schemas.STATUS.validate(value);
  if (result.isValid) return {...result,outsideContract:false};
  const isValid = wholeFieldMatch(globalThis.OCR_CONTRACT.categories.status.review_pattern, value);
  return {isValid,errorMsg:isValid ? null : 'Invalid status transcription',outsideContract:isValid};
};
const UnknownSchema = {isPartial:() => false,isPrefix:() => false,validate:() => ({isValid:false,errorMsg:'Unsupported OCR region'}),getSuggestion:() => null};
const SchemaRegistry = {
  getCategory(id) {
    const rule = globalThis.OCR_CONTRACT.region_rules.find(rule => wholeFieldMatch(rule.pattern,id));
    return rule?.category || null;
  },
  getSchema(id) { return Schemas[ContractCategories[this.getCategory(id)]] || UnknownSchema; },
  validateReviewed(id, value) {
    const schema = this.getSchema(id);
    return schema.validateReviewed ? schema.validateReviewed(value) : schema.validate(value);
  },
};
