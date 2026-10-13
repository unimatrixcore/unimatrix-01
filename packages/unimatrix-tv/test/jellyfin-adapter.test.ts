import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBootGate } from '../src/loading-gate.js';
import { installJellyfinAdapter } from '../src/jellyfin-adapter.js';

describe('installJellyfinAdapter', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.body.innerHTML = '';
    location.hash = '#/home';
    vi.useRealTimers();
  });

  it('decorates movie and series cards with Jellyseerr badges and hover overlay', () => {
    // Setup home page with a movie card and a series card
    const homeTab = document.createElement('div');
    homeTab.id = 'homeTab';
    // Emulate getBoundingClientRect height > 0
    Object.defineProperty(homeTab, 'getBoundingClientRect', {
      value: () => ({ height: 500, width: 1000, top: 0, bottom: 500, left: 0, right: 1000 }),
    });

    const section = document.createElement('div');
    section.className = 'verticalSection';

    // Movie card
    const movieCard = document.createElement('div');
    movieCard.className = 'card';
    movieCard.dataset.id = 'm1';
    movieCard.dataset.type = 'Movie';
    const movieBox = document.createElement('div');
    movieBox.className = 'cardBox';
    const movieImg = document.createElement('div');
    movieImg.className = 'cardImageContainer';
    movieBox.appendChild(movieImg);
    const movieFooter = document.createElement('div');
    movieFooter.className = 'cardFooter';
    const movieTitle = document.createElement('div');
    movieTitle.className = 'cardText cardText-first';
    movieTitle.textContent = 'Spider-Man: Brand New Day';
    const movieYear = document.createElement('div');
    movieYear.className = 'cardText cardText-secondary';
    movieYear.textContent = '2026';
    movieFooter.append(movieTitle, movieYear);
    movieCard.append(movieBox, movieFooter);

    // Series card
    const seriesCard = document.createElement('div');
    seriesCard.className = 'card';
    seriesCard.dataset.id = 's1';
    seriesCard.dataset.type = 'Series';
    const seriesBox = document.createElement('div');
    seriesBox.className = 'cardBox';
    const seriesImg = document.createElement('div');
    seriesImg.className = 'cardImageContainer';
    seriesBox.appendChild(seriesImg);
    const seriesFooter = document.createElement('div');
    seriesFooter.className = 'cardFooter';
    const seriesTitle = document.createElement('div');
    seriesTitle.className = 'cardText cardText-first';
    seriesTitle.textContent = 'Severance';
    seriesFooter.appendChild(seriesTitle);
    seriesCard.append(seriesBox, seriesFooter);

    section.append(movieCard, seriesCard);
    homeTab.appendChild(section);
    document.body.appendChild(homeTab);

    // Mock ApiClient
    (window as Window & { ApiClient?: unknown }).ApiClient = {
      getCurrentUserId: () => 'u1',
      serverId: () => 'srv1',
      getItems: vi.fn().mockResolvedValue({ Items: [] }),
      getItem: vi.fn().mockResolvedValue({}),
      getUserViews: vi.fn().mockResolvedValue({ Items: [] }),
      getImageUrl: () => 'https://img.example.com',
    };

    const gate = createBootGate({ transitionMs: 10 });
    installJellyfinAdapter(gate);

    // Verify Movie card has Jellyseerr badges and hover overlay
    const movieBadges = movieCard.querySelector('.utv-card-badges');
    expect(movieBadges).not.toBeNull();
    const moviePill = movieBadges?.querySelector('.utv-card-type-badge');
    expect(moviePill?.textContent).toBe('MOVIE');
    expect(moviePill?.classList.contains('utv-badge-movie')).toBe(true);
    expect(movieBadges?.querySelector('.utv-card-status-badge')).not.toBeNull();

    const movieOverlay = movieCard.querySelector('.utv-card-hover-overlay');
    expect(movieOverlay).not.toBeNull();
    expect(movieOverlay?.querySelector('.utv-card-title')?.textContent).toBe('Spider-Man: Brand New Day');
    expect(movieOverlay?.querySelector('.utv-card-year')?.textContent).toBe('2026');

    // Verify Series card has SERIES pill badge
    const seriesBadges = seriesCard.querySelector('.utv-card-badges');
    expect(seriesBadges).not.toBeNull();
    const seriesPill = seriesBadges?.querySelector('.utv-card-type-badge');
    expect(seriesPill?.textContent).toBe('SERIES');
    expect(seriesPill?.classList.contains('utv-badge-series')).toBe(true);
  });

  it('hides CollectionFolder generic folders from homeTab shelves', () => {
    const homeTab = document.createElement('div');
    homeTab.id = 'homeTab';
    Object.defineProperty(homeTab, 'getBoundingClientRect', {
      value: () => ({ height: 500, width: 1000, top: 0, bottom: 500, left: 0, right: 1000 }),
    });

    const folderSection = document.createElement('div');
    folderSection.className = 'verticalSection';
    const folderCard = document.createElement('div');
    folderCard.className = 'card';
    folderCard.dataset.type = 'CollectionFolder';
    folderSection.appendChild(folderCard);

    homeTab.appendChild(folderSection);
    document.body.appendChild(homeTab);

    (window as Window & { ApiClient?: unknown }).ApiClient = {
      getCurrentUserId: () => 'u1',
      serverId: () => 'srv1',
      getItems: vi.fn().mockResolvedValue({ Items: [] }),
      getItem: vi.fn().mockResolvedValue({}),
      getUserViews: vi.fn().mockResolvedValue({ Items: [] }),
      getImageUrl: () => 'https://img.example.com',
    };

    const gate = createBootGate({ transitionMs: 10 });
    installJellyfinAdapter(gate);

    expect(folderSection.style.display).toBe('none');
  });
});
