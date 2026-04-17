// --- Lilin Hi-Fi Tuning (Aggression 0.70) ---
const G1: f32 = 0.70;
const G2: f32 = G1 * f32(0.75); const G3: f32 = G2 * f32(0.55);
const G4: f32 = G3 * f32(0.35); const G5: f32 = G4 * f32(0.20);
const G6: f32 = G5 * f32(0.15); const G7: f32 = G6 * f32(0.10);

const W1: f32 = f32(1.0); const W2: f32 = f32(0.5); const W3: f32 = f32(0.25);
const W4: f32 = f32(0.15); const W5: f32 = f32(0.10); const W6: f32 = f32(0.06); const W7: f32 = f32(0.04);

@inline
function hardClip(x: f32): f32 {
    if (x > f32(1.0)) return f32(1.0);
    if (x < f32(-1.0)) return f32(-1.0);
    return x;
}

@inline
function interpolate(y0: f32, y1: f32, y2: f32, y3: f32, t: f32): f32 {
    const a0: f32 = f32(-0.5) * y0 + f32(1.5) * y1 - f32(1.5) * y2 + f32(0.5) * y3;
    const a1: f32 = y0 - f32(2.5) * y1 + f32(2.0) * y2 - f32(0.5) * y3;
    const a2: f32 = f32(-0.5) * y0 + f32(0.5) * y2;
    const a3: f32 = y1;
    return a0 * t * t * t + a1 * t * t + a2 * t + a3;
}

export function process_simd(
    inputPtr: usize, outputPtr: usize, sincTablePtr: usize,
    historyPtr: usize, statePtr: usize,
    len: i32, oversample: i32, taps: i32, 
    targetGain: f32,
    b1: f32, b2: f32, b3: f32 // 動的に再計算されたB係数を受け取る
): void {
    let i1: f32 = load<f32>(statePtr + 0);  let i2: f32 = load<f32>(statePtr + 4);
    let i3: f32 = load<f32>(statePtr + 8);  let i4: f32 = load<f32>(statePtr + 12);
    let i5: f32 = load<f32>(statePtr + 16); let i6: f32 = load<f32>(statePtr + 20);
    let i7: f32 = load<f32>(statePtr + 24); let fb: f32 = load<f32>(statePtr + 28);
    let currentGain: f32 = load<f32>(statePtr + 32);
    let h0: f32 = load<f32>(statePtr + 36); let h1: f32 = load<f32>(statePtr + 40);
    let h2: f32 = load<f32>(statePtr + 44); let h3: f32 = load<f32>(statePtr + 48);

    let gainStep: f32 = (targetGain - currentGain) / f32(len);

    for (let i = 0; i < len; i++) {
        currentGain += gainStep;
        let x_in = load<f32>(inputPtr + i * 4) * currentGain;

        for (let k = 0; k < taps - 1; k++) {
            store<f32>(historyPtr + k * 4, load<f32>(historyPtr + (k + 1) * 4));
        }
        store<f32>(historyPtr + (taps - 1) * 4, x_in);

        let acc: f32 = 0.0;
        let weightTotal: f32 = 0.0;

        for (let step4 = 0; step4 < 4; step4++) {
            let vx = f32x4.splat(0.0);
            let offset = step4 * (oversample / 4);
            for (let k = 0; k < taps; k++) {
                vx = f32x4.add(vx, f32x4.mul(f32x4.splat(load<f32>(historyPtr + k * 4)), 
                     v128.load(sincTablePtr + ((taps - 1 - k) * oversample + offset) * 4)));
            }
            let next_fir_val = f32x4.extract_lane(vx, 0);
            h0 = h1; h1 = h2; h2 = h3; h3 = next_fir_val;

            for (let j32 = 0; j32 < 32; j32++) {
                let t = f32(j32) / f32(32.0);
                let x = interpolate(h0, h1, h2, h3, t);

                let delta = x - fb;
                i1 += delta * G1;
                // 引数として受け取った b1, b2, b3 を使用
                i2 += (i1 - i3 * b1) * G2;
                i3 += i2 * G3;
                i4 += (i3 - i5 * b2) * G4;
                i5 += i4 * G5;
                i6 += (i5 - i7 * b3) * G6;
                i7 += i6 * G7;

                const leak: f32 = f32(0.99985);
                i1 *= leak; i2 *= leak; i3 *= leak; i4 *= leak; i5 *= leak; i6 *= leak; i7 *= leak;

                fb = hardClip(i1*W1 + i2*W2 + i3*W3 + i4*W4 + i5*W5 + i6*W6 + i7*W7);

                let jj = f32(step4 * 32 + j32);
                let weight = jj * (f32(oversample) - jj); 
                acc += fb * weight;
                weightTotal += weight;
            }
        }

        if (isNaN(i1) || f32(Math.abs(i1)) > f32(50.0)) { i1=i2=i3=i4=i5=i6=i7=fb=f32(0.0); }
        store<f32>(outputPtr + i * 4, (acc / weightTotal) / currentGain);
    }

    store<f32>(statePtr + 0, i1);   store<f32>(statePtr + 4, i2);
    store<f32>(statePtr + 8, i3);   store<f32>(statePtr + 12, i4);
    store<f32>(statePtr + 16, i5);  store<f32>(statePtr + 20, i6);
    store<f32>(statePtr + 24, i7);  store<f32>(statePtr + 28, fb);
    store<f32>(statePtr + 32, currentGain);
    store<f32>(statePtr + 36, h0);  store<f32>(statePtr + 40, h1);
    store<f32>(statePtr + 44, h2);  store<f32>(statePtr + 48, h3);
}