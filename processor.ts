const W1: f32 = f32(0.9); const W2: f32 = f32(0.75); const W3: f32 = f32(0.25);
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
    targetLevel: f32, expansionDepth: f32, aggression: f32, sampleRate: f32,
    exciteAmount: f32, exciteMix: f32
): void {
    // ハイパスフィルタの係数計算（カットオフ周波数 fc を指定）
    // fs_osr = sampleRate * oversample （既にprocess_simd内で計算済み）
    // 1次後退差分による簡易HPF係数
    const fc: f32 = f32(10000.0); // カットオフ周波数 Hz（10kHz）
    const fs_osr = sampleRate * f32(oversample);
    const hpCoeff: f32 = f32(1.0) - f32(2.0) * f32(Math.PI) * fc / fs_osr;

    const curG1 = aggression;
    const curG2 = curG1 * f32(0.75); const curG3 = curG2 * f32(0.55);
    const curG4 = curG3 * f32(0.35); const curG5 = curG4 * f32(0.20);
    const curG6 = curG5 * f32(0.15); const curG7 = curG6 * f32(0.10);

    const b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(4000)) / sampleRate), 2));
    const b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(8000)) / sampleRate), 2));
    const b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(14000)) / sampleRate), 2));

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
        let hpState: f32 = load<f32>(sP + 56);  // 既存の最後(sP+52)の次
        let curRMS: f32 = load<f32>(sP + 60);   // 新規追加：RMS追跡用

        // ブロックピーク（既存、エキスパンダー用）
        let blockPeak: f32 = 0.0;
        for (let i = 0; i < len; i++) {
            let a = f32(Math.abs(load<f32>(inP + i * 4)));
            if (a > blockPeak) blockPeak = a;
        }

        // ブロックRMS（新規追加、弱音動作点用）
        let blockRMS: f32 = 0.0;
        for (let i = 0; i < len; i++) {
            let s = load<f32>(inP + i * 4);
            blockRMS += s * s;
        }
        blockRMS = f32(Math.sqrt(f64(blockRMS / f32(len))));

        // 2. ピークの追従更新 (processor.js.oldと同等のロジック)
        if (blockPeak > curPeak) {
            curPeak = blockPeak * f32(1.1);
        } else {
            curPeak += (blockPeak - curPeak) * f32(0.0001); // ブロック長に応じた減衰
        }

        // RMS追従（ピークより遅い時定数で残響に追従）
        if (blockRMS > curRMS) {
            curRMS = blockRMS * f32(1.05);
        } else {
            curRMS += (blockRMS - curRMS) * f32(0.00005); // ピークの半分の速度
        }

        // 3. ゲインの計算 (冪乗カーブを含む)
        const safePeak: f32 = curPeak > f32(0.01) ? curPeak : f32(0.01);
        const safeRMS: f32 = curRMS > f32(0.005) ? curRMS : f32(0.005);
        const baseGain = targetLevel / safePeak;
        const expansionFactor = f32(Math.pow(f64(safePeak), f64(expansionDepth - f32(1.0))));
        // RMSが小さい時（残響・弱音）に動作点を上げる補正
        // RMSが低いほど追加ゲインがかかる、ただし上限を設ける
        const rmsBoost: f32 = f32(0.15) / safeRMS < f32(1.4) ? f32(0.15) / safeRMS : f32(1.4);

        const targetGain = f32(baseGain * expansionFactor) * rmsBoost;

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
                    // === ハーモニック・エキサイター ===
                    // FIRで得たオーバーサンプル済みサンプル x に対して適用
                    // （interpolate の結果 x を使う、ΔΣループの先頭）
                    // 1. ハイパス（簡易1次差分フィルタ、~10kHz相当）
                    //    hpState はstateに追加する1変数
                    let hp: f32 = x - hpState;
                    hpState = hpState * hpCoeff + x * (f32(1.0) - hpCoeff);  // 係数で遮断周波数を調整
                    //    0.85 ≈ 10kHz@192kHz(=48k×4)  0.90 ≈ 7kHz  0.80 ≈ 14kHz

                    // 2. odd次のみのソフトクリップ（3rd+5th倍音を生成）
                    let driven: f32 = hp * (f32(1.0) + exciteAmount);
                    let excited: f32 = driven - (driven * driven * driven) * f32(0.333);
                    //    x - x³/3 はtanh近似。odd次歪みのみ生成される

                    // 3. 元信号に薄く加算（ΔΣへの入力として）
                    let x_excited: f32 = x + (excited - hp) * exciteMix;

                    // 以降の delta = x_excited - fb に変更
                    let delta: f32 = x_excited - fb;
                    i1 += delta * curG1;
                    i2 += (i1 - i3 * b1) * curG2;
                    i3 += i2 * curG3;
                    i4 += (i3 - i5 * b2) * curG4;
                    i5 += i4 * curG5;
                    i6 += (i5 - i7 * b3) * curG6;
                    i7 += i6 * curG7;

                    const leak: f32 = f32(1);
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
        store<f32>(sP + 56, hpState);
        store<f32>(sP + 60, curRMS);
    }
}
