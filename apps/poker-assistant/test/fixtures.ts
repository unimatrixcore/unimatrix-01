import type { PokerBootstrap, PokerResult } from "@unimatrix/shared";
import { emptySession } from "@unimatrix/poker";

export const bootstrap: PokerBootstrap = {
  dataDir: "/tmp/poker-assistant-test",
  monitors: [{ name: "TEST-1", width: 1920, height: 1080 }],
  settings: { monitor: "TEST-1", username: "Player1", captureIntervalMs: 1000 },
  session: emptySession(),
  history: [],
  stats: { images: 0, captures: 0, emptyLabels: 0, byRegion: {} },
  regions: { "seat.0.name": { x: 10, y: 10, w: 20, h: 20 } },
  screenWidth: 1920,
  screenHeight: 1080,
  warnings: [],
};
export const game: PokerResult<"game_state"> = {
  screenshot:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'%3E%3Crect width='1920' height='1080' fill='%23102018'/%3E%3C/svg%3E",
  state: {
    in_play_seats: [0, 3],
    seat_usernames: { "0": "Player1", "3": "Player2" },
    seat_cards: { "0": ["As", "Kh_"] },
    seat_bets: { "3": "G 5 BB" },
    active_seat: 3,
    active_seat_color: "#ff0000",
    my_seat_index: 0,
    community_cards: ["Ac", "7h", "2d", null, null],
    game_id: "#123456",
  },
};
