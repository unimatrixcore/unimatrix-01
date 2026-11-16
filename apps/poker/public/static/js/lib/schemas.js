// --- Schema System ---

// --- Declarative Schema System ---

const Schemas = {
  NAME: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => contractPartial("name", val),
    getSuggestion: (val) => {
      if (!val) return null;
      const pool = [...new Set([...usernamePool.getItems(), ...(typeof nativeNameSuggestions === "undefined" ? [] : nativeNameSuggestions)])];
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
    isPartial: (val) => contractPartial('status', val),
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
    isPartial: function(val) { const rank = globalThis.OCR_CONTRACT.normalization?.rank_aliases?.[val.toUpperCase()] || val.toUpperCase(); return !val || this.ranks.some(r => r.startsWith(rank)); },
    getSuggestion: (val) => val === "1" ? { suggestion: "10", type: 'append' } : null
  },
  MONEY: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => contractPartial('bet',val),
    isAtPrefix: () => false,
    getSuggestion: (val) => {
      if (!val.endsWith(' B')) return null;
      const candidate=val+'B';
      return contractValid('bet',candidate) ? {suggestion:candidate,type:'append'} : null;
    }
  },
  BANK: {
    noChips: globalThis.OCR_CONTRACT.categories.bank.partial_values.filter(value => value.endsWith('No Chips')),
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => contractPartial("bank",val),
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
    isPartial: (val) => contractPartial('pot',val),
    isAtPrefix: () => false,
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
      if (val.endsWith(' B') && contractValid('pot', val+'B')) return {suggestion:val+'B',type:'append'};
      return Schemas.MONEY.getSuggestion(val, item);
    }
  },
  SPLIT_POT: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => contractPartial('split_pot',val),
    isAtPrefix: () => false,
    getSuggestion: (val) => {
      if (!val.endsWith(' B')) return null;
      const candidate=val+'B';
      return contractValid('split_pot',candidate) ? {suggestion:candidate,type:'append'} : null;
    }
  },
  DEALER: {
    isPrefix: function(val) { return this.isPartial(val); },
    isPartial: (val) => !val || val === "D",
    getSuggestion: (val) => val.toLowerCase() === "d" && val !== "D" ? { suggestion: "D", type: 'replace' } : null
  }
};

// Same JSON bytes are used by persistence, model suggestions and training.
const ContractCategories = {name:'NAME',status:'STATUS',card:'CARD',dealer:'DEALER',bank:'BANK',bet:'MONEY',pot:'POT',split_pot:'SPLIT_POT',round_id:'ROUND_ID',suit:'SUIT',amount:'AMOUNT',table_info:'TABLE_INFO',timer:'TIMER',popup:'POPUP',combination:'COMBINATION',winner:'WINNER'};
const wholeFieldMatch = (pattern, value) => {
  if (typeof value !== 'string') return false;
  const match = new RegExp('^(?:' + pattern + ')$').exec(value);
  return !!match && match[0] === value;
};
const contractValid = (category, value) => {
  const rule = globalThis.OCR_CONTRACT.categories[category];
  if (!rule || typeof value !== 'string') return false;
  if (rule.max_utf16 !== undefined && value.length > rule.max_utf16) return false;
  if (rule.prefix_max_utf16 !== undefined && value.slice(0,value.lastIndexOf(", NLHE")).length > rule.prefix_max_utf16) return false;
  return rule.values && rule.values_exhaustive !== false ? rule.values.includes(value) : wholeFieldMatch(rule.pattern, value);
};
function contractPartial(category,value) {
  const rule=globalThis.OCR_CONTRACT.categories[category];
  if (!rule || typeof value !== 'string') return false;
  if (rule.max_utf16 !== undefined && value.length > rule.max_utf16) return false;
  if (!value || contractValid(category,value)) return true;
  if (rule.partial_values?.some(v=>v.toLowerCase().startsWith(value.toLowerCase()))) return true;
  if (rule.partial_pattern) return wholeFieldMatch(rule.partial_pattern,value);
  if (rule.values && rule.values_exhaustive !== false) return rule.values.some(v=>v.startsWith(value));
  return category !== 'round_id' || value.startsWith('#');
}
Schemas.ROUND_ID = {isPartial:value=>contractPartial('round_id',value),isPrefix:function(value){return this.isPartial(value);},getSuggestion:()=>null};
for (const [category,name] of Object.entries(ContractCategories)) {
  if (!Schemas[name]) Schemas[name]={isPartial:value=>contractPartial(category,value),isPrefix:value=>contractPartial(category,value),getSuggestion:()=>null};
}
Schemas.SUIT.isPartial = value => {
  const glyph=value.replace(/[\ufe0e\ufe0f]/g,'');
  const canonical=globalThis.OCR_CONTRACT.normalization?.suit_aliases?.[glyph] || glyph.toLowerCase();
  return !value || globalThis.OCR_CONTRACT.categories.suit.values.includes(canonical);
};
Schemas.SUIT.getSuggestion = value => {
  const glyph=value.replace(/[\ufe0e\ufe0f]/g,'');
  const canonical=globalThis.OCR_CONTRACT.normalization?.suit_aliases?.[glyph] || glyph.toLowerCase();
  return canonical!==value && globalThis.OCR_CONTRACT.categories.suit.values.includes(canonical) ? {suggestion:canonical,type:'replace'} : null;
};
for (const [category, name] of Object.entries(ContractCategories)) {
  Schemas[name].validate = value => {
    const isValid = contractValid(category, value);
    return {isValid,errorMsg:isValid ? null : 'Invalid ' + category.replaceAll('_',' ') + ' format'};
  };
}
// Format validity does not establish visual verification.
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
