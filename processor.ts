const W1: f32 = f32(1.0); const W2: f32 = f32(0.55); const W3: f32 = f32(0.30);
const W4: f32 = f32(0.18); const W5: f32 = f32(0.12); const W6: f32 = f32(0.07); const W7: f32 = f32(0.05);

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

export function generateSincTable(sincTablePtr: usize, oversample: i32, taps: i32): void {
    const size = oversample * taps;
    const center = (taps / 2) * oversample;
    for (let i = 0; i < size; i++) {
        const x = f32(i - center) / f32(oversample);
        if (x == f32(0)) {
            store<f32>(sincTablePtr + i * 4, f32(1.0));
        } else {
            const pix = f32(Math.PI) * x;
            const window = f32(0.42) - f32(0.5) * f32(Math.cos(f64((f32(2) * f32(Math.PI) * f32(i)) / f32(size - 1)))) + f32(0.08) * f32(Math.cos(f64((f32(4) * f32(Math.PI) * f32(i)) / f32(size - 1))));
            store<f32>(sincTablePtr + i * 4, (f32(Math.sin(f64(pix))) / pix) * window);
        }
    }
}

export function process_simd(
    inputLPtr: usize, inputRPtr: usize, outputLPtr: usize, outputRPtr: usize,
    sincTablePtr: usize, historyLPtr: usize, historyRPtr: usize,
    stateLPtr: usize, stateRPtr: usize,
    len: i32, oversample: i32, taps: i32,
    targetLevel: f32, expansionDepth: f32, aggression: f32, sampleRate: f32
): void {
    const curG1 = aggression;
    const curG2 = curG1 * f32(0.75); const curG3 = curG2 * f32(0.55);
    const curG4 = curG3 * f32(0.35); const curG5 = curG4 * f32(0.20);
    const curG6 = curG5 * f32(0.15); const curG7 = curG6 * f32(0.10);

    const fs_osr = sampleRate * f32(oversample);
    const b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(10390)) / fs_osr), 2));
    const b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(17000)) / fs_osr), 2));
    const b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(24760)) / fs_osr), 2));

    for (let ch = 0; ch < 2; ch++) {
        const inP = ch == 0 ? inputLPtr : inputRPtr;
        const outP = ch == 0 ? outputLPtr : outputRPtr;
        const histP = ch == 0 ? historyLPtr : historyRPtr;
        const sP = ch == 0 ? stateLPtr : stateRPtr;

        // 状態のデロード
        let i1 = load<f32>(sP + 0); let i2 = load<f32>(sP + 4);
        let i3 = load<f32>(sP + 8); let i4 = load<f32>(sP + 12);
        let i5 = load<f32>(sP + 16); let i6 = load<f32>(sP + 20);
        let i7 = load<f32>(sP + 24); let fb = load<f32>(sP + 28);
        let curPeak = load<f32>(sP + 32);
        let h0 = load<f32>(sP + 36); let h1 = load<f32>(sP + 40);
        let h2 = load<f32>(sP + 44); let h3 = load<f32>(sP + 48);
        let lastGain = load<f32>(sP + 52); // 前回のゲインを保持 (滑らかな遷移用)

        // 1. ブロック内のピーク検出 (ノイズ防止のため重要)
        let blockPeak: f32 = 0.0;
        for (let i = 0; i < len; i++) {
            let a = f32(Math.abs(load<f32>(inP + i * 4)));
            if (a > blockPeak) blockPeak = a;
        }

        // 2. ピークの追従更新 (processor.js.oldと同等のロジック)
        if (blockPeak > curPeak) {
            curPeak = blockPeak * f32(1.1);
        } else {
            curPeak += (blockPeak - curPeak) * f32(0.0001); // ブロック長に応じた減衰
        }

        // 3. ゲインの計算 (冪乗カーブを含む)
        const safePeak = Math.max(f32(0.01), curPeak);
        const baseGain = targetLevel / safePeak;
        const expansionFactor = f32(Math.pow(f64(safePeak), f64(expansionDepth - f32(1.0))));
        const targetGain = f32(baseGain * expansionFactor);

        // 前回のゲインから緩やかに遷移させるためのステップ
        if (lastGain == f32(0)) lastGain = targetGain;
        let gainStep = (targetGain - lastGain) / f32(len);
        let currentGain = lastGain;

        // 4. メイン処理
        for (let i = 0; i < len; i++) {
            currentGain += gainStep;
            let raw = load<f32>(inP + i * 4);
            let x_in = raw * currentGain;

            // FIR
            for (let k = 0; k < taps - 1; k++) {
                store<f32>(histP + k * 4, load<f32>(histP + (k + 1) * 4));
            }
            store<f32>(histP + (taps - 1) * 4, x_in);

            let acc: f32 = 0.0;
            let weightTotal: f32 = 0.0;

            for (let step4 = 0; step4 < 4; step4++) {
                let vx = f32x4.splat(0.0);
                let offset = step4 * (oversample / 4);
                for (let k = 0; k < taps; k++) {
                    vx = f32x4.add(vx, f32x4.mul(f32x4.splat(load<f32>(histP + k * 4)),
                        v128.load(sincTablePtr + ((taps - 1 - k) * oversample + offset) * 4)));
                }
                let next_fir = f32x4.extract_lane(vx, 0);
                h0 = h1; h1 = h2; h2 = h3; h3 = next_fir;

                for (let j32 = 0; j32 < 32; j32++) {
                    let t = f32(j32) / f32(32.0);
                    let x = interpolate(h0, h1, h2, h3, t);

                    let delta = x - fb;
                    i1 += delta * curG1;
                    i2 += (i1 - i3 * b1) * curG2;
                    i3 += i2 * curG3;
                    i4 += (i3 - i5 * b2) * curG4;
                    i5 += i4 * curG5;
                    i6 += (i5 - i7 * b3) * curG6;
                    i7 += i6 * curG7;

                    const leak: f32 = f32(0.99985);
                    i1 *= leak; i2 *= leak; i3 *= leak; i4 *= leak; i5 *= leak; i6 *= leak; i7 *= leak;
                    fb = hardClip(i1 * W1 + i2 * W2 + i3 * W3 + i4 * W4 + i5 * W5 + i6 * W6 + i7 * W7);

                    let jj = f32(step4 * 32 + j32);
                    let weight = jj * (f32(oversample) - jj);
                    acc += fb * weight;
                    weightTotal += weight;
                }
            }

            if (isNaN(i1) || f32(Math.abs(i1)) > f32(8.0)) { i1 = i2 = i3 = i4 = i5 = i6 = i7 = fb = f32(0.0); }
            store<f32>(outP + i * 4, f32((acc / weightTotal) / currentGain));
        }

        // 状態保存
        store<f32>(sP + 0, i1); store<f32>(sP + 4, i2);
        store<f32>(sP + 8, i3); store<f32>(sP + 12, i4);
        store<f32>(sP + 16, i5); store<f32>(sP + 20, i6);
        store<f32>(sP + 24, i7); store<f32>(sP + 28, fb);
        store<f32>(sP + 32, curPeak);
        store<f32>(sP + 36, h0); store<f32>(sP + 40, h1);
        store<f32>(sP + 44, h2); store<f32>(sP + 48, h3);
        store<f32>(sP + 52, currentGain); // 最後時点でのゲインを保存
    }
}
