import type { PokerAssistantColors } from "@unimatrix/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { invoke } from "./invoke.js";

// Keep preferences alongside the native application's XDG configuration. Await
// writes in order so a slower earlier request cannot replace a newer setting.
let preferenceWrite = Promise.resolve();
let preferencesReady = false;
const preferencesStorage: StateStorage = {
  getItem: async (key) => {
    const saved = await invoke<string | null>("load_preferences");
    if (saved !== null) {
      preferencesReady = true;
      return saved;
    }
    const legacy = localStorage.getItem(key);
    if (legacy !== null) {
      await invoke("save_preferences", { value: legacy });
      localStorage.removeItem(key);
    }
    preferencesReady = true;
    return legacy;
  },
  setItem: (_key, value) => {
    // Startup color/game updates must not persist default preferences before
    // the asynchronous native read has restored the saved username/monitor.
    if (!preferencesReady) return Promise.resolve();
    preferenceWrite = preferenceWrite
      .catch(() => {})
      .then(() => invoke<void>("save_preferences", { value }));
    return preferenceWrite;
  },
  removeItem: () =>
    preferencesStorage.setItem(
      "poker-assistant-storage",
      JSON.stringify({ state: {}, version: 0 }),
    ),
};

export interface PokerState {
  recommendation: string;
  equity: number;
  isRunning: boolean;
  selectedMonitorIndex: number | null;
  username: string;
  colors: PokerAssistantColors | null;
  debugInfo: {
    inPlaySeats: number[];
    seatUsernames: Record<number, string>;
    seatCards: Record<number, string[]>;
    seatBets: Record<number, string>;
    seatBanks: Record<number, string>;
    seatStatuses: Record<number, string>;
    seatDealers: Record<number, string>;
    pot: string | null;
    splitPot: string | null;
    activeSeat: number | null;
    activeSeatColor: string | null;
    mySeatIndex: number | null;
    gameId: string | null;
    communityCards: (string | null)[];
  };
  clearGameState: () => void;
  setRecommendation: (rec: string) => void;
  setEquity: (equity: number) => void;
  setIsRunning: (running: boolean) => void;
  setSelectedMonitorIndex: (id: number | null) => void;
  setUsername: (username: string) => void;
  setColors: (colors: PokerState["colors"]) => void;
  setDebugInfo: (info: Partial<PokerState["debugInfo"]>) => void;
}

export const usePokerStore = create<PokerState>()(
  persist(
    (set) => ({
      recommendation: "Waiting for hand...",
      equity: 0,
      isRunning: false,
      selectedMonitorIndex: null,
      username: "",
      colors: null,
      debugInfo: {
        inPlaySeats: [],
        seatUsernames: {},
        seatCards: {},
        seatBets: {},
        seatBanks: {},
        seatStatuses: {},
        seatDealers: {},
        pot: null,
        splitPot: null,
        activeSeat: null,
        activeSeatColor: null,
        mySeatIndex: null,
        gameId: null,
        communityCards: [],
      },
      clearGameState: () =>
        set({
          recommendation: "Waiting for verified game state...",
          equity: 0,
          debugInfo: {
            inPlaySeats: [],
            seatUsernames: {},
            seatCards: {},
            seatBets: {},
            seatBanks: {},
            seatStatuses: {},
            seatDealers: {},
            pot: null,
            splitPot: null,
            activeSeat: null,
            activeSeatColor: null,
            mySeatIndex: null,
            gameId: null,
            communityCards: [],
          },
        }),
      setRecommendation: (rec) => set({ recommendation: rec }),
      setEquity: (equity) => set({ equity }),
      setIsRunning: (isRunning) => set({ isRunning }),
      setSelectedMonitorIndex: (selectedMonitorIndex) => set({ selectedMonitorIndex }),
      setUsername: (username) => set({ username }),
      setColors: (colors: PokerState["colors"]) => set({ colors }),
      setDebugInfo: (info) =>
        set((state) => ({
          debugInfo: { ...state.debugInfo, ...info },
        })),
    }),
    {
      name: "poker-assistant-storage",
      storage: createJSONStorage(() => preferencesStorage),
      partialize: (state) => ({
        username: state.username,
        selectedMonitorIndex: state.selectedMonitorIndex,
      }),
    },
  ),
);
