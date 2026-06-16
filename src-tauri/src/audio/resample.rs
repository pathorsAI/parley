/// Streaming linear resampler from an arbitrary input rate to a target rate,
/// operating on mono `f32` samples and emitting `i16` PCM.
///
/// It keeps `prev`/`frac` state across calls so repeated `process` invocations
/// on successive audio callback buffers stay phase-continuous (no pitch drift or
/// clicks at buffer boundaries). Linear interpolation is more than adequate for
/// speech sent to an STT engine; a higher-quality polyphase resampler (rubato)
/// can replace this later without changing the interface.
pub struct LinearResampler {
    /// Input samples consumed per output sample (= in_rate / out_rate).
    step: f64,
    /// Fractional position in [0, 1) between `prev` and the current sample.
    frac: f64,
    prev: f32,
    has_prev: bool,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            step: in_rate as f64 / out_rate as f64,
            frac: 0.0,
            prev: 0.0,
            has_prev: false,
        }
    }

    /// Resample a mono `f32` buffer, appending `i16` PCM to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<i16>) {
        for &cur in input {
            if !self.has_prev {
                self.prev = cur;
                self.has_prev = true;
                continue;
            }
            // Emit every output sample whose position falls between prev and cur.
            while self.frac < 1.0 {
                let v = self.prev + (cur - self.prev) * self.frac as f32;
                out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                self.frac += self.step;
            }
            self.frac -= 1.0;
            self.prev = cur;
        }
    }
}

/// Little-endian byte representation of a PCM s16le buffer.
pub fn pcm_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}
