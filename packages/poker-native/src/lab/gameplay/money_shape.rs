use image::RgbImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const POLICY: &str = "source_money_channels_v1";
const BACKGROUND: [f64; 3] = [15., 33., 46.];
// Recovered SC/GC SVG fill and inner-letter colors; matching also requires the inner stroke.
const PALETTES: [([f64; 3], [f64; 3]); 2] = [
    ([108., 222., 7.], [31., 64., 2.]),
    ([255., 200., 0.], [71., 56., 0.]),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Plane {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}
impl Plane {
    fn valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && u64::from(self.width) * u64::from(self.height) <= 1_000_000
            && self.data.len() == self.width as usize * self.height as usize
    }
    fn pixel(&self, x: i32, y: i32) -> f64 {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            0.
        } else {
            f64::from(self.data[y as usize * self.width as usize + x as usize])
        }
    }
    fn interpolated(&self, x: f64, y: f64) -> f64 {
        let (ix, iy) = (x.floor() as i32, y.floor() as i32);
        let (fx, fy) = (x - f64::from(ix), y - f64::from(iy));
        self.pixel(ix, iy) * (1. - fx) * (1. - fy)
            + self.pixel(ix + 1, iy) * fx * (1. - fy)
            + self.pixel(ix, iy + 1) * (1. - fx) * fy
            + self.pixel(ix + 1, iy + 1) * fx * fy
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Signature {
    pub policy: String,
    pub palette: u8,
    pub white: Plane,
    pub coin: Plane,
    pub topology: [usize; 2],
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    (0..3).map(|i| a[i] * b[i]).sum()
}
fn difference(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
fn bounds(data: &[u8], w: u32, h: u32) -> Option<[u32; 4]> {
    let (mut left, mut top, mut right, mut bottom) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if data[y as usize * w as usize + x as usize] > 0 {
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1)
            }
        }
    }
    (right > left && bottom > top).then_some([left, top, right, bottom])
}
fn tight(data: &[u8], w: u32, h: u32) -> Option<Plane> {
    let [l, t, r, b] = bounds(data, w, h)?;
    let mut result = Vec::new();
    for y in t..b {
        result.extend_from_slice(&data[(y * w + l) as usize..(y * w + r) as usize]);
    }
    Some(Plane {
        width: r - l,
        height: b - t,
        data: result,
    })
}

fn topology(plane: &Plane) -> [usize; 2] {
    fn components(plane: &Plane, foreground: bool, holes_only: bool) -> usize {
        let (w, h) = (plane.width as usize, plane.height as usize);
        let mut visited = vec![false; w * h];
        let mut count = 0;
        for start in 0..visited.len() {
            if visited[start] || (plane.data[start] >= 128) != foreground {
                continue;
            }
            visited[start] = true;
            let mut stack = vec![start];
            let mut edge = false;
            while let Some(index) = stack.pop() {
                let (x, y) = (index % w, index / w);
                edge |= x == 0 || y == 0 || x + 1 == w || y + 1 == h;
                for (nx, ny) in [
                    (x as i32 - 1, y as i32),
                    (x as i32 + 1, y as i32),
                    (x as i32, y as i32 - 1),
                    (x as i32, y as i32 + 1),
                ] {
                    if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                        let next = ny as usize * w + nx as usize;
                        if !visited[next] && (plane.data[next] >= 128) == foreground {
                            visited[next] = true;
                            stack.push(next);
                        }
                    }
                }
            }
            if !holes_only || !edge {
                count += 1
            }
        }
        count
    }
    [
        components(plane, true, false),
        components(plane, false, true),
    ]
}

pub fn extract(image: &RgbImage, mask: &Value) -> Option<Signature> {
    if mask["policy"] != crate::lab::gameplay::crop_mask::POLICY
        || !["chip_columns_value", "single_chip_value"].contains(&mask["source"].as_str()?)
        || mask["panels"].as_array()?.len() != 1
    {
        return None;
    }
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 1_000_000 {
        return None;
    }
    let pixels = image
        .pixels()
        .map(|p| p.0.map(f64::from))
        .collect::<Vec<_>>();
    if !pixels.contains(&BACKGROUND) {
        return None;
    }
    let palettes = PALETTES
        .iter()
        .enumerate()
        .filter(|(_, (fill, dark))| pixels.contains(fill) && pixels.contains(dark))
        .collect::<Vec<_>>();
    if palettes.len() != 1 {
        return None;
    }
    let (palette, (fill, dark)) = palettes[0];
    let (fill, dark) = (*fill, *dark);
    let mut white = Vec::with_capacity(pixels.len());
    let mut opaque_coin = Vec::with_capacity(pixels.len());
    for pixel in &pixels {
        let alpha = (0..3)
            .map(|i| (pixel[i] - BACKGROUND[i]) / (255. - BACKGROUND[i]))
            .sum::<f64>()
            / 3.;
        let residual = (0..3)
            .map(|i| (pixel[i] - (BACKGROUND[i] + alpha * (255. - BACKGROUND[i]))).abs())
            .fold(0., f64::max);
        white.push(if residual <= 1.1 && (0.02..=1.01).contains(&alpha) {
            (alpha * 255.).clamp(0., 255.).round() as u8
        } else {
            0
        });
        let alpha = dot(*pixel, fill) / dot(fill, fill);
        let residual = (0..3)
            .map(|i| (pixel[i] - alpha * fill[i]).abs())
            .fold(0., f64::max);
        opaque_coin.push(u8::from(residual <= 1.1 && (0.27..=1.01).contains(&alpha)));
    }
    let white = tight(&white, w, h)?;
    let [l, t, r, b] = bounds(&opaque_coin, w, h)?;
    // Both recovered SVG letters fit inside this source-coordinate square (2.5..11.5 of14).
    // It excludes the circle's composited outer edge while retaining every S/G letter stroke.
    let inset = 2.5 / 14.;
    let (x0, x1) = (
        (f64::from(l) + f64::from(r - l) * inset).ceil() as u32,
        (f64::from(r) - f64::from(r - l) * inset).floor() as u32,
    );
    let (y0, y1) = (
        (f64::from(t) + f64::from(b - t) * inset).ceil() as u32,
        (f64::from(b) - f64::from(b - t) * inset).floor() as u32,
    );
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let direction = difference(fill, dark);
    let divisor = dot(direction, direction);
    let mut coin = vec![0u8; pixels.len()];
    for y in y0..y1 {
        for x in x0..x1 {
            let index = (y * w + x) as usize;
            let pixel = pixels[index];
            let alpha = (dot(difference(fill, pixel), direction) / divisor).clamp(0., 1.);
            let residual = (0..3)
                .map(|i| (pixel[i] - (fill[i] - alpha * direction[i])).abs())
                .fold(0., f64::max);
            if residual > 2. {
                return None;
            }
            if alpha >= 0.02 {
                coin[index] = (alpha * 255.).round() as u8;
            }
        }
    }
    let coin = tight(&coin, w, h)?;
    if !coin.data.iter().any(|v| *v >= 135) {
        return None;
    }
    let topology = topology(&coin);
    Some(Signature {
        policy: POLICY.into(),
        palette: palette as u8,
        white,
        coin,
        topology,
    })
}

fn registered(a: &Plane, b: &Plane) -> bool {
    if a.width.abs_diff(b.width) > 1 || a.height.abs_diff(b.height) > 1 {
        return false;
    }
    for qy in -4..=4 {
        for qx in -4..=4 {
            let (dx, dy) = (f64::from(qx) / 4., f64::from(qy) / 4.);
            let mut valid = true;
            let mut shared = 0;
            'pixels: for y in 0..a.height.max(b.height) + 6 {
                for x in 0..a.width.max(b.width) + 6 {
                    let av = a.pixel(x as i32 - 3, y as i32 - 3);
                    let bv = b.interpolated(f64::from(x) - 3. - dx, f64::from(y) - 3. - dy);
                    if av <= 120. && bv >= 135. || bv <= 120. && av >= 135. {
                        valid = false;
                        break 'pixels;
                    }
                    if av >= 135. && bv >= 135. {
                        shared += 1;
                    }
                }
            }
            if valid && shared > 0 {
                return true;
            }
        }
    }
    false
}

pub fn equivalent(a: &Signature, b: &Signature) -> bool {
    a.policy == POLICY
        && b.policy == POLICY
        && a.white.valid()
        && b.white.valid()
        && a.coin.valid()
        && b.coin.valid()
        && a.palette == b.palette
        && a.white == b.white
        && a.topology == b.topology
        && registered(&a.coin, &b.coin)
        && registered(&b.coin, &a.coin)
}

pub fn bucket(signature: &Signature) -> String {
    let mut bytes = format!(
        "{POLICY}:{}:{}x{}:",
        signature.palette, signature.white.width, signature.white.height
    )
    .into_bytes();
    bytes.extend_from_slice(&signature.white.data);
    crate::lab::sha256(&bytes)
}
