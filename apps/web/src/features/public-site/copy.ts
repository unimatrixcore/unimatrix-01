const exactReplacements = new Map<string, string>([
  ["Designation Pending", "Project in progress"],
  ["Transmission Pending", "Post in progress"],
  [
    "This node is a personal portfolio rendered like a Collective interface: projects, writing, and system design notes arranged for inspection instead of spectacle.",
    "This is a personal portfolio with projects, writing, and system design notes arranged to be useful, legible, and easy to browse.",
  ],
  [
    "Assimilate good patterns, expose the contract, keep the architecture legible, and leave every system easier for the next contributor to extend.",
    "Adopt strong patterns, expose the contract, keep the architecture legible, and leave every system easier for the next contributor to extend.",
  ],
  [
    "I build software the same way I imagine starships should be built: with clear internal structure, reliable interfaces, and enough transparency that another engineer can step in without guessing what the hull is hiding. Most of my work starts in TypeScript and Node.js, then branches into API design, typed contracts, automation, and the security questions that keep distributed systems honest.",
    "I build software with clear internal structure, reliable interfaces, and enough transparency that another engineer can step in without guessing how things work. Most of my work starts in TypeScript and Node.js, then branches into API design, typed contracts, automation, and the security questions that keep distributed systems honest.",
  ],
  [
    "That is why I keep coming back to repo-backed content, shared contracts, and composition over cleverness. Good patterns deserve assimilation: not because every project should become identical, but because proven structure frees attention for the hard decisions. I want codebases that can absorb improvement without losing their shape.",
    "That is why I keep coming back to repo-backed content, shared contracts, and composition over cleverness. Good patterns deserve reuse: not because every project should become identical, but because proven structure frees attention for the hard decisions. I want codebases that can absorb improvement without losing their shape.",
  ],
  [
    "This node awaits activation. Project details will be assimilated upon deployment.",
    "This project is in progress. Public details will be added when the work is ready to share.",
  ],
  [
    "This project entry is in standby while the wider system finishes alignment. The frame exists, the channel is open, and the full technical dossier will materialize when the work is ready for public inspection.",
    "This project entry is in standby while the wider system comes together. The structure is in place, and the full write-up will be added when the work is ready for public review.",
  ],
  [
    "Until then, consider this a reserved integration point inside the Collective. Architecture is being stabilized, interfaces are being stress-tested, and the final record will be published only when the implementation can defend its own shape.",
    "Until then, treat this as a reserved integration point. Architecture is being stabilized, interfaces are being stress-tested, and the final write-up will be published only when the implementation can stand on its own.",
  ],
  ["The silence is temporary. Assimilation continues off-screen.", "More detail is on the way."],
  [
    "This log entry is queued for authoring. Content will materialize when the Collective deems it relevant.",
    "This post is queued for writing. It will be published when it is ready to be useful.",
  ],
  [
    "This transmission slot has been reserved but not yet populated. The signal is acknowledged; the authored payload is still being refined into a form worthy of deployment.",
    "This draft slot has been reserved but not yet filled in. The piece is still being refined into something worth publishing.",
  ],
  [
    "When the channel opens, expect a concise field report: architecture, implementation tradeoffs, and whatever lessons survived first contact with reality.",
    "When it is ready, expect a concise write-up on architecture, implementation tradeoffs, and what held up in practice.",
  ],
  ["For now, the buffer remains warm and the queue remains active.", "For now, it remains in the queue."],
]);

const patternReplacements: Array<[RegExp, string]> = [
  [/\bCollective\b/gu, "site"],
  [/\bcollective\b/gu, "site"],
  [/\bnode\b/gu, "site"],
  [/\bNode\b/gu, "Site"],
  [/\bdossier\b/gu, "write-up"],
  [/\bDossier\b/gu, "Write-up"],
  [/\btransmission\b/gu, "post"],
  [/\bTransmission\b/gu, "Post"],
  [/\bhandshake\b/gu, "connection"],
  [/\bHandshake\b/gu, "Connection"],
  [/\batlas\b/gu, "site map"],
  [/\bAtlas\b/gu, "Site map"],
  [/\boperator\b/gu, "developer"],
  [/\bOperator\b/gu, "Developer"],
];

export function normalizePortfolioCopy(value: string): string {
  if (exactReplacements.has(value)) {
    return exactReplacements.get(value)!;
  }

  return patternReplacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}
