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

The app has two modes, chosen up front: Learn walks new OLL or PLL cases one at a time in a fixed teaching order, so you can mark each as known as you pick it up. Drill draws flashcards from whichever cases you've enabled, weighted by real-world case frequency, for fast keyboard-driven recall practice. Both modes track per-case progress in the browser, so learning and training pool selections persist between sessions without an account.

Algorithm data is sourced directly from [J Perm's algorithm trainer](https://jperm.net/algs), and the app is built on the same TanStack Router, Tailwind, and shadcn UI stack as the rest of this site.
