// 「フラット寄り」にしたい場合
// W1: 0.80  // 下げる → 高域（8k〜）を抑制
// W2: 0.45  // 下げる → 4k〜のブーストを抑える
// W3: 0.30  // 現状維持
// W4〜W7は音質への影響がほぼないため、安定性優先で現状維持

// 「ドンシャリ」にしたい場合
// W1: 1.20  // 上げる → 高域を持ち上げ
// W2: 0.40  // 下げる → 中域をへこます
// W3: 0.45  // 上げる → 低中域を足す

// 「ボーカル前面」にしたい場合
// W1: 0.90
// W2: 0.75  // 上げる → 2〜4kHzのプレゼンス強化
// W3: 0.25  // 下げる → 低中域を引く

const W1: f32 = f32(0.80); const W2: f32 = f32(0.45); const W3: f32 = f32(0.30);
const W4: f32 = f32(0.18); const W5: f32 = f32(0.12); const W6: f32 = f32(0.07); const W7: f32 = f32(0.05);

@inline
function hardClip(x: f32): f32 {
    if (x > f32(1.0)) return f32(1.0);
    if (x < f32(-1.0)) return f32(-1.0);
    return x;
}
@inline
function processChannel(
    inP: usize, outP: usize, histP: usize, sP: usize,
    sincTablePtr: usize,
    len: i32, oversample: i32, taps: i32, tapsMask: i32,
    weightTotalConst: f32,
    G1: f32, G2: f32, G3: f32, G4: f32,
    G5: f32, G6: f32, G7: f32,
    b1: f32, b2: f32, b3: f32,
    targetLevel: f32, expansionDepth: f32,
    exciteAmount: f32, exciteMix: f32
): void {
    // 状態ロード
    let i1 = load<f32>(sP + 0); let i2 = load<f32>(sP + 4);
    let i3 = load<f32>(sP + 8); let i4 = load<f32>(sP + 12);
    let i5 = load<f32>(sP + 16); let i6 = load<f32>(sP + 20);
    let i7 = load<f32>(sP + 24); let fb = load<f32>(sP + 28);
    let curPeak = load<f32>(sP + 32);
    let lastGain = load<f32>(sP + 36);
    let hpState = load<f32>(sP + 40);
    let curRMS = load<f32>(sP + 44);
    let writePos = load<i32>(sP + 48);
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
        store<f32>(histP + writePos * 4, x_in);
        let newestPos: i32 = writePos;
        writePos = (writePos + 1) & tapsMask;

        // 循環バッファを一時線形バッファに展開（ランダムアクセスをここで解消）
        // tmpBuf[k] = history[newestPos - k]（新しい順）
        // Wasmメモリの空き領域を一時バッファとして使用
        // tmpBufPtr はprocess_simd引数に追加するか固定アドレスを使う
        // → ここでは historyRPtr + taps*4 の直後の空き領域を仮定
        // → 実際にはprocessor.jsで専用アドレスを割り当てる（後述）

        // SIMD内積: sum[j] = Σ_k h[k] * table[k * oversample + j]
        // j を4つずつ処理、v128.loadで table[k*oversample+j..j+3] を一括ロード
        let acc0 = f32x4.splat(0.0);  // j=0,1,2,3
        let acc1 = f32x4.splat(0.0);  // j=4,5,6,7
        let acc2 = f32x4.splat(0.0);  // j=8,9,10,11
        let acc3 = f32x4.splat(0.0);  // j=12,13,14,15
        // ... oversample/4 個のアキュムレータが必要
        // oversample=128なら32個 → 変数が多すぎるため配列的アクセスが必要

        // 現実的な実装: jループを外、kループを内にする
        // accをf32x4のベクトルとして持つ（oversample/4個）
        // AssemblyScriptでは動的サイズのローカルf32x4配列が使えないため
        // 以下の構造が現実的:

        let vAcc = f32x4.splat(0.0); // 4位相分のアキュムレータ

        let scalarAcc: f32 = 0.0; // デシメーション用スカラー累積

        for (let j = 0; j < oversample; j += 4) {
            vAcc = f32x4.splat(0.0);

            for (let k = 0; k < taps; k++) {
                let bufIdx: i32 = (newestPos - k + taps) & tapsMask;
                let h: f32 = load<f32>(histP + bufIdx * 4);
                // transTable[k * oversample + j] の4要素を一括ロード
                let coeff = v128.load(sincTablePtr + (k * oversample + j) * 4);
                vAcc = f32x4.add(vAcc, f32x4.mul(f32x4.splat(h), coeff));
            }

            // 4サブサンプルをΔΣに投入
            for (let sub = 0; sub < 4; sub++) {
                let x: f32 = sub == 0 ? f32x4.extract_lane(vAcc, 0) :
                    sub == 1 ? f32x4.extract_lane(vAcc, 1) :
                        sub == 2 ? f32x4.extract_lane(vAcc, 2) :
                            f32x4.extract_lane(vAcc, 3);

                // エキサイター
                let hp: f32 = x - hpState;
                hpState = hp * (f32(1.0) - exciteMix) + x * exciteMix;
                let x_excited: f32 = x + hp * exciteAmount;

                // ΔΣ
                let delta: f32 = x_excited - fb;
                i1 += delta * G1;
                i2 += (i1 - i3 * b1) * G2;
                i3 += i2 * G3;
                i4 += (i3 - i5 * b2) * G4;
                i5 += i4 * G5;
                i6 += (i5 - i7 * b3) * G6;
                i7 += i6 * G7;
                fb = hardClip(i1 * W1 + i2 * W2 + i3 * W3 + i4 * W4 + i5 * W5 + i6 * W6 + i7 * W7);

                let jj: f32 = f32(j + sub);
                scalarAcc += fb * jj * (f32(oversample) - jj);
            }
        }

        if (isNaN(i1) || f32(Math.abs(i1)) > f32(8.0)) {
            i1 = i2 = i3 = i4 = i5 = i6 = i7 = fb = f32(0.0);
        }
        store<f32>(outP + i * 4, scalarAcc / weightTotalConst / currentGain);
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

// 新レイアウト: transTable[k * oversample + j]
// → kループ内で j方向に連続アクセス可能
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
            // 新レイアウト: transTable[tap * oversample + phase]
            store<f32>(tablePtr + (tap * oversample + phase) * 4, val);
        }
    }
}

export function process_simd(
    inputLPtr: usize, inputRPtr: usize,
    outputLPtr: usize, outputRPtr: usize,
    sincTablePtr: usize,
    historyLPtr: usize, historyRPtr: usize,
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

    const G1 = aggression;
    const G2 = G1 * f32(0.75); const G3 = G2 * f32(0.55);
    const G4 = G3 * f32(0.35); const G5 = G4 * f32(0.20);
    const G6 = G5 * f32(0.15); const G7 = G6 * f32(0.10);

    const b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(4000)) / sampleRate), 2));
    const b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(8000)) / sampleRate), 2));
    const b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(14000)) / sampleRate), 2));

    const tapsMask: i32 = taps - 1;

    let weightTotalConst: f32 = f32(0.0);
    for (let jj = 0; jj < oversample; jj++) {
        weightTotalConst += f32(jj) * (f32(oversample) - f32(jj));
    }
    // LとRを明示的に個別呼び出し
    processChannel(
        inputLPtr, outputLPtr, historyLPtr, stateLPtr,
        sincTablePtr, len, oversample, taps, tapsMask,
        weightTotalConst, G1, G2, G3, G4, G5, G6, G7,
        b1, b2, b3, targetLevel, expansionDepth, exciteAmount, exciteMix
    );
    processChannel(
        inputRPtr, outputRPtr, historyRPtr, stateRPtr,
        sincTablePtr, len, oversample, taps, tapsMask,
        weightTotalConst, G1, G2, G3, G4, G5, G6, G7,
        b1, b2, b3, targetLevel, expansionDepth, exciteAmount, exciteMix
    );
}
