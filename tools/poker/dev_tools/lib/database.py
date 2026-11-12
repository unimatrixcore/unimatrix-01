import sqlite3
import threading
import json
from pathlib import Path
from .ocr_contract import validate_label

class Database:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._local = threading.local()
        self.lock = threading.Lock()
        self._init_db()

    def _get_conn(self):
        if not hasattr(self._local, "conn"):
            self._local.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_db(self):
        conn = self._get_conn()
        cursor = conn.cursor()
        
        # Enable WAL mode for better concurrency
        cursor.execute("PRAGMA journal_mode=WAL")
        
        # Table for master screenshots
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS full_captures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT UNIQUE,
                monitor TEXT,
                timestamp INTEGER,
                regions_hash TEXT
            )
        """)
        
        # Table for individual crops
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT UNIQUE,
                phash TEXT,
                label TEXT,
                region_id TEXT,
                source_id INTEGER,
                timestamp INTEGER,
                FOREIGN KEY (source_id) REFERENCES full_captures (id)
            )
        """)

        # Add missing columns if they don't exist (incremental schema update)
        cursor.execute("PRAGMA table_info(images)")
        columns = [row['name'] for row in cursor.fetchall()]
        for col in ['x', 'y', 'w', 'h']:
            if col not in columns:
                cursor.execute(f"ALTER TABLE images ADD COLUMN {col} INTEGER")
        
        # Table for tool settings
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        
        # Table for session progress
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS session_progress (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data TEXT
            )
        """)

        # Table for session history
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS session_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER,
                data TEXT
            )
        """)

        # Indexes for performance
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_region_id ON images(region_id)")
        
        conn.commit()

    def execute(self, query, params=()):
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            cursor.execute(query, params)
            conn.commit()
            return cursor

    def executemany(self, query, params_list):
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            cursor.executemany(query, params_list)
            conn.commit()
            return cursor

    def fetchone(self, query, params=()):
        # fetchone doesn't strictly need a lock, but let's be safe
        with self.lock:
            cursor = self._get_conn().cursor()
            cursor.execute(query, params)
            return cursor.fetchone()

    def fetchall(self, query, params=()):
        with self.lock:
            cursor = self._get_conn().cursor()
            cursor.execute(query, params)
            return cursor.fetchall()

    def add_image(self, filename, phash, label, region_id, source_filename=None, rect=None):
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            
            source_id = None
            if source_filename:
                row = cursor.execute("SELECT id FROM full_captures WHERE filename = ?", (source_filename,)).fetchone()
                if row:
                    source_id = row['id']
            
            import time
            ts = int(time.time() * 1000)
            
            x, y, w, h = (rect['x'], rect['y'], rect['w'], rect['h']) if rect else (None, None, None, None)
            
            cursor.execute("""
                INSERT OR REPLACE INTO images (filename, phash, label, region_id, source_id, timestamp, x, y, w, h)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (filename, phash, label, region_id, source_id, ts, x, y, w, h))
            conn.commit()

    def add_images_batch(self, entries):
        """Perform batch insertion of image crops within a single transaction."""
        import time
        ts = int(time.time() * 1000)
        
        with self.lock:
            conn = self._get_conn()
            cursor = conn.cursor()
            
            # Cache source filenames to IDs to avoid redundant lookups
            source_cache = {}
            
            params_list = []
            for e in entries:
                filename = f"{e['id'].replace('.', '_').replace('[', '_').replace(']', '_')}_{e['phash']}.png"
                source_filename = e.get('source')
                
                source_id = None
                if source_filename:
                    if source_filename in source_cache:
                        source_id = source_cache[source_filename]
                    else:
                        row = cursor.execute("SELECT id FROM full_captures WHERE filename = ?", (source_filename,)).fetchone()
                        if row:
                            source_id = row['id']
                            source_cache[source_filename] = source_id
                
                rect = e.get('rect')
                x, y, w, h = (rect['x'], rect['y'], rect['w'], rect['h']) if rect else (None, None, None, None)
                phash = e['phash']
                region_id = e['id']
                label = validate_label(region_id, e.get('label', ''))
                
                params_list.append((filename, phash, label, region_id, source_id, ts, x, y, w, h))
            
            cursor.executemany("""
                INSERT OR REPLACE INTO images (filename, phash, label, region_id, source_id, timestamp, x, y, w, h)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, params_list)
            conn.commit()

    def get_all_images(self):
        return self.fetchall("SELECT * FROM images ORDER BY timestamp DESC")

    def delete_images(self, filenames):
        self.executemany("DELETE FROM images WHERE filename = ?", [(f,) for f in filenames])

    def update_label(self, filename, label):
        row = self.fetchone("SELECT region_id FROM images WHERE filename = ?", (filename,))
        if row:
            label = validate_label(row['region_id'], label)
            self.execute("UPDATE images SET label = ? WHERE filename = ?", (label, filename))

    def get_settings(self, default=None):
        row = self.fetchone("SELECT value FROM settings WHERE key = 'config'")
        if row:
            return json.loads(row['value'])
        return default or {}

    def save_settings(self, settings):
        self.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('config', ?)", (json.dumps(settings),))

    def get_session_progress(self):
        row = self.fetchone("SELECT data FROM session_progress WHERE id = 1")
        if row:
            return json.loads(row['data'])
        return None

    def save_session_progress(self, data):
        self.execute("INSERT OR REPLACE INTO session_progress (id, data) VALUES (1, ?)", (json.dumps(data),))

    def get_session_history(self):
        rows = self.fetchall("SELECT data FROM session_history ORDER BY timestamp DESC")
        return [json.loads(row['data']) for row in rows]

    def add_session_history(self, timestamp, data):
        self.execute("INSERT INTO session_history (timestamp, data) VALUES (?, ?)", (timestamp, json.dumps(data)))

    def add_full_capture(self, filename, monitor, regions_hash):
        import time
        ts = int(time.time() * 1000)
        self.execute("""
            INSERT OR REPLACE INTO full_captures (filename, monitor, timestamp, regions_hash)
            VALUES (?, ?, ?, ?)
        """, (filename, monitor, ts, regions_hash))

    def get_statistics(self):
        import collections
        import math
        import re
        import random
        
        def normalize_id(rid):
            if not rid: return "Other"
            rid_lower = rid.lower()
            if ".name" in rid_lower or rid_lower.endswith("name"): return "Name"
            if "status" in rid_lower: return "Status"
            if "dealer" in rid_lower: return "Dealer"
            if "community" in rid_lower or ".cards" in rid_lower or "hand" in rid_lower: return "Card"
            if "split" in rid_lower and "pot" in rid_lower: return "Split Pot"
            if "pot" in rid_lower: return "Pot"
            if "bank" in rid_lower: return "Bank"
            if "bet" in rid_lower: return "Bet"
            return "Other"

        stats = {}
        
        # 1. Dataset Overview
        total_row = self.fetchone("SELECT COUNT(*) as total FROM images")
        text_row = self.fetchone("SELECT COUNT(*) as total FROM images WHERE label != ''")
        stats['overview'] = {
            'total': total_row['total'] or 0,
            'text': text_row['total'] or 0,
            'empty': (total_row['total'] or 0) - (text_row['total'] or 0)
        }
        
        # 2. Model Training & Distributions (Grouped)
        all_images = self.fetchall("SELECT region_id, label, phash, w, h FROM images")
        
        region_counts = collections.Counter()
        top_labels = collections.Counter()
        
        char_counts = collections.Counter()
        label_lengths = []
        region_data = collections.defaultdict(lambda: {'labels': [], 'phashes': [], 'aspect_ratios': []})
        
        for row in all_images:
            rid = normalize_id(row['region_id'])
            region_counts[rid] += 1
            
            l = row['label']
            if l:
                top_labels[l] += 1
                label_lengths.append(len(l))
                char_counts.update(l)
                
                rd = region_data[rid]
                rd['labels'].append(l)
                if row['phash']: rd['phashes'].append(row['phash'])
                if row['w'] is not None and row['h'] is not None and row['h'] > 0:
                    rd['aspect_ratios'].append(row['w'] / row['h'])

        stats['regions'] = dict(region_counts)
        stats['top_labels'] = dict(top_labels.most_common(10))
        
        # Crop Sizes
        crop_stats = self.fetchone("SELECT MIN(w) as min_w, MAX(w) as max_w, AVG(w) as avg_w, MIN(h) as min_h, MAX(h) as max_h, AVG(h) as avg_h FROM images")
        stats['crops'] = {k: round(v, 2) if v is not None else 0 for k, v in dict(crop_stats).items()}
        
        total_labeled_count = len(label_lengths)
        stats['lengths'] = {
            'min': min(label_lengths) if label_lengths else 0,
            'max': max(label_lengths) if label_lengths else 0,
            'avg': round(sum(label_lengths)/total_labeled_count, 2) if total_labeled_count > 0 else 0
        }

        # 4. Per-Region Quality
        per_region_stats = {}
        for rid, data in region_data.items():
            labels = data['labels']
            phashes = data['phashes']
            ars = data['aspect_ratios']
            
            avg_dist = 0
            if len(phashes) > 1:
                pairs = 0
                total_dist = 0
                sample_size = min(len(phashes) * 2, 100)
                for _ in range(sample_size):
                    p1 = random.choice(phashes)
                    p2 = random.choice(phashes)
                    if p1 == p2: continue
                    try:
                        total_dist += bin(int(p1, 16) ^ int(p2, 16)).count('1')
                        pairs += 1
                    except: continue
                avg_dist = round(total_dist / pairs, 2) if pairs > 0 else 0

            per_region_stats[rid] = {
                'unique_labels': len(set(labels)),
                'avg_len': round(sum(len(l) for l in labels)/len(labels), 2) if labels else 0,
                'avg_dist': avg_dist,
                'avg_ar': round(sum(ars)/len(ars), 2) if ars else 0
            }
        stats['per_region'] = per_region_stats

        # 5. Poker-Domain Specific
        currency = {'G': 0, 'S': 0}
        actions = collections.Counter()
        all_in_count = 0
        action_keywords = ["Call", "Raise", "Check", "Bet", "All-In", "Fold", "SB", "BB", "Straddle"]
        
        for l_list in [rd['labels'] for rd in region_data.values()]:
            for l in l_list:
                if l.startswith('G '): currency['G'] += 1
                elif l.startswith('S '): currency['S'] += 1
                for ak in action_keywords:
                    if ak.lower() in l.lower(): actions[ak] += 1
                if "all-in" in l.lower(): all_in_count += 1
                
        stats['poker'] = {
            'currency': currency,
            'actions': dict(actions),
            'all_in_rate': round((all_in_count / total_labeled_count * 100), 2) if total_labeled_count > 0 else 0
        }
        
        return stats
