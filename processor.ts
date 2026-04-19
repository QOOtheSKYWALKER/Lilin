const W1: f32 = f32(0.9); const W2: f32 = f32(0.75); const W3: f32 = f32(0.25);
const W4: f32 = f32(0.18); const W5: f32 = f32(0.12); const W6: f32 = f32(0.07); const W7: f32 = f32(0.05);

@inline
function hardClip(x: f32): f32 {
    if (x > f32(1.0)) return f32(1.0);
    if (x < f32(-1.0)) return f32(-1.0);
    return x;
}

// generateSincTable を generatePolyphaseTable に置き換え
// テーブルのレイアウトを転置する：
// 旧: sincTable[tap * oversample + phase]
// 新: polyTable[phase * taps + tap]  ← FIR1回のアクセスが連続になる

export function generatePolyphaseTable(
    tablePtr: usize, oversample: i32, taps: i32
): void {
    const size = oversample * taps;
    const center = (taps / 2) * oversample;
    for (let phase = 0; phase < oversample; phase++) {
        for (let tap = 0; tap < taps; tap++) {
            const i = tap * oversample + phase; // 旧レイアウトでの位置
            const x = f32(i - center) / f32(oversample);
            let val: f32;
            if (x == f32(0)) {
                val = f32(1.0);
            } else {
                const pix = f32(Math.PI) * x;
                const window = f32(0.42)
                    - f32(0.5) * f32(Math.cos(f64(f32(2.0) * f32(Math.PI) * f32(i) / f32(size - 1))))
                    + f32(0.08) * f32(Math.cos(f64(f32(4.0) * f32(Math.PI) * f32(i) / f32(size - 1))));
                val = (f32(Math.sin(f64(pix))) / pix) * window;
            }
            // 新レイアウト: polyTable[phase * taps + tap]
            store<f32>(tablePtr + (phase * taps + tap) * 4, val);
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

    const tapsMask: i32 = taps - 1;

    let weightTotalConst: f32 = f32(0.0);
    for (let jj = 0; jj < oversample; jj++) {
        weightTotalConst += f32(jj) * (f32(oversample) - f32(jj));
    }

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
        let lastGain = load<f32>(sP + 36); // 旧sP+52
        let hpState: f32 = load<f32>(sP + 40); // 旧sP+56
        let curRMS: f32 = load<f32>(sP + 44);  // 旧sP+60
        let writePos: i32 = load<i32>(sP + 48);

        // ブロックピーク（既存、エキスパンダー用）
        // ブロックRMS（新規追加、弱音動作点用）
        let blockPeak: f32 = 0.0;
        let blockRMS: f32 = 0.0;
        for (let i = 0; i < len; i++) {
            let s = load<f32>(inP + i * 4);
            let a = s < f32(0.0) ? -s : s;  // 絶対値をif不要で計算
            if (a > blockPeak) blockPeak = a;
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

        for (let i = 0; i < len; i++) {
            currentGain += gainStep;
            let x_in = load<f32>(inP + i * 4) * currentGain;

            // 循環バッファ書き込み
            // writePosを先に使ってから進める（書き込み後のwritePosが「次の空き位置」）
            store<f32>(histP + writePos * 4, x_in);
            // FIR計算での最新サンプルindex = writePos（書き込んだ直後）
            // 古い順: writePos, writePos-1, ..., writePos-(taps-1)
            // しかし「新しい順にk番目」= (writePos - k + taps) % taps  ← 負数なし
            let newestPos: i32 = writePos; // 今書いた位置
            writePos = (writePos + 1) & tapsMask;

            let acc: f32 = 0.0;

            // jを1ずつ進め、4位相ごとにSIMD処理
            for (let j = 0; j < oversample; j += 4) {
                let sum0: f32 = 0.0;
                let sum1: f32 = 0.0;
                let sum2: f32 = 0.0;
                let sum3: f32 = 0.0;

                // Polyphase内積：テーブルはphase方向に連続
                // polyTable[j*taps + k] の k方向ループ
                const base0 = sincTablePtr + j * taps * 4;
                const base1 = sincTablePtr + (j + 1) * taps * 4;
                const base2 = sincTablePtr + (j + 2) * taps * 4;
                const base3 = sincTablePtr + (j + 3) * taps * 4;

                for (let k = 0; k < taps; k++) {
                    // 新しい順にk番目のサンプル（負数回避のため+tapsしてからmod）
                    let bufIdx = (newestPos - k + taps) & tapsMask;
                    let h: f32 = load<f32>(histP + bufIdx * 4);

                    sum0 += h * load<f32>(base0 + k * 4);
                    sum1 += h * load<f32>(base1 + k * 4);
                    sum2 += h * load<f32>(base2 + k * 4);
                    sum3 += h * load<f32>(base3 + k * 4);
                }

                // 4サブサンプルをΔΣに投入
                for (let sub = 0; sub < 4; sub++) {
                    let x: f32 = sub == 0 ? sum0 : sub == 1 ? sum1 :
                        sub == 2 ? sum2 : sum3;

                    let hp: f32 = x - hpState;
                    hpState = hpState * hpCoeff + x * (f32(1.0) - hpCoeff);
                    let driven: f32 = hp * (f32(1.0) + exciteAmount);
                    let excited: f32 = driven - (driven * driven * driven) * f32(0.333);
                    let x_excited: f32 = x + (excited - hp) * exciteMix;

                    let delta: f32 = x_excited - fb;
                    i1 += delta * curG1;
                    i2 += (i1 - i3 * b1) * curG2;
                    i3 += i2 * curG3;
                    i4 += (i3 - i5 * b2) * curG4;
                    i5 += i4 * curG5;
                    i6 += (i5 - i7 * b3) * curG6;
                    i7 += i6 * curG7;
                    fb = hardClip(i1 * W1 + i2 * W2 + i3 * W3 + i4 * W4 + i5 * W5 + i6 * W6 + i7 * W7);

                    let jj: f32 = f32(j + sub);
                    let weight: f32 = jj * (f32(oversample) - jj);
                    acc += fb * weight;
                    //                    weightTotal += weight;
                }
            }

            if (isNaN(i1) || f32(Math.abs(i1)) > f32(8.0)) {
                i1 = i2 = i3 = i4 = i5 = i6 = i7 = fb = f32(0.0);
            }
            store<f32>(outP + i * 4, (acc / weightTotalConst) / currentGain);
        }

        // 状態保存（writePosを追加）
        store<f32>(sP + 0, i1); store<f32>(sP + 4, i2);
        store<f32>(sP + 8, i3); store<f32>(sP + 12, i4);
        store<f32>(sP + 16, i5); store<f32>(sP + 20, i6);
        store<f32>(sP + 24, i7); store<f32>(sP + 28, fb);
        store<f32>(sP + 32, curPeak);
        store<f32>(sP + 36, currentGain);
        store<f32>(sP + 40, hpState);
        store<f32>(sP + 44, curRMS);
        store<i32>(sP + 48, writePos); // i32として保存
    }
}