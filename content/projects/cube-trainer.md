---
title: Cube Trainer
slug: cube-trainer
publishedAt: 2026-07-22
summary: A flashcard trainer for memorizing every 3x3 Rubik's Cube OLL and PLL algorithm.
status: active
featured: true
liveUrl: https://cube.unimatrix-01.dev
---
Cube Trainer is a browser-based drill tool for the last-layer stage of the CFOP speedcubing method: 57 OLL cases for orienting the last layer, and 21 PLL cases for permuting it into place.

Each algorithm set has two modes. Browse mode lists every case grouped by shape or permutation type, with move notation and alternate algorithms. Trainer mode draws cases as flashcards, weighted by real-world case frequency, and tracks per-case status (new, learning, known) in the browser so progress persists between sessions without an account.

Algorithm data is sourced directly from [J Perm's algorithm trainer](https://jperm.net/algs), and the app is built on the same TanStack Router, Tailwind, and shadcn UI stack as the rest of this site.
