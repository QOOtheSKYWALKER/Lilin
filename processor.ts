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

const W1: f32 = f32(0.90); const W2: f32 = f32(0.75); const W3: f32 = f32(0.25);
const W4: f32 = f32(0.18); const W5: f32 = f32(0.12); const W6: f32 = f32(0.07); const W7: f32 = f32(0.05);

// === Wasm内部グローバル（JSから触らない） ===
let b1: f32 = 0.0; let b2: f32 = 0.0; let b3: f32 = 0.0;

let g_taps: i32 = 0;
let g_tapsMask: i32 = 0;
let g_oversample: i32 = 0;
let g_sampleRate: f32 = 0.0;
let g_hpCoeff: f32 = 0.0;

// 固定メモリアドレス（processor.jsのPtr定義と一致させる）
const INPUT_L: usize = 10000;
const INPUT_R: usize = 20000;
const OUTPUT_L: usize = 30000;
const OUTPUT_R: usize = 40000;
const SINC_PTR: usize = 50000;
const HIST_L: usize = 1100000;
const HIST_R: usize = 1200000;
const STATE_L: usize = 1300000;
const STATE_R: usize = 1400000;
// デシメーション用テーブルをWasmメモリに追加
const DECI_PTR: usize = 200000; // 新規アドレス（50000 + 128*128*4 = 115712でSINCと被らないか確認）
const FB_BUF_L: usize = 300000;     //FIR用バッファ
const FB_BUF_R: usize = 300000 + 128 * 4;  // 128サンプル×4byte = 512byte後ろ

// Kaiser窓の実装（generatePolyphaseTable内で置き換え）
// β = 8.0 → 阻止域減衰 ~80dB、遷移帯域は狭い
// β = 10.0 → 阻止域減衰 ~100dB、さらに急峻

@inline
function kaiserWindow(i: i32, N: i32, beta: f32): f32 {
    const n_f = f32(N - 1);
    const x = (f32(2.0) * f32(i)) / n_f - f32(1.0);
    const x2 = x * x;
    const arg = beta * f32(Math.sqrt(f64(f32(1.0) - (x2 > f32(1.0) ? f32(1.0) : x2))));
    return besselI0(arg) / besselI0(beta);
}

@inline
function besselI0(x: f32): f32 {
    let sum: f32 = f32(1.0);
    let term: f32 = f32(1.0);
    const x_2 = x / f32(2.0);
    const x_2_sq = x_2 * x_2;
    for (let k = 1; k <= 20; k++) {
        term *= x_2_sq / f32(k * k);
        sum += term;
        if (term < f32(1e-6)) break;
    }
    return sum;
}

// cutoff = 0.5 → カットオフを sampleRate/4 に設定
@inline
function generatePolyphaseTable(): void {
    const cutoff: f32 = f32(1.0); // 1.0 = sr/2 (Nyquist), 0.5 = sr/4
    const size = g_oversample * g_taps;
    const center = (g_taps / 2) * g_oversample;
    for (let tap = 0; tap < g_taps; tap++) {
        for (let phase = 0; phase < g_oversample; phase++) {
            const i = tap * g_oversample + phase;
            const xf = f32(i - center) / f32(g_oversample) * cutoff;
            const pix = f32(Math.PI) * xf;
            const window = kaiserWindow(i, size, f32(8.0));

            let val: f32;
            if (xf == f32(0)) {
                // sinc(0) = 1.0 に cutoff を掛けてゲインを合わせる
                val = cutoff * window;
            } else {
                // sin(pix)/pix に window と cutoff を掛ける
                val = cutoff * (f32(Math.sin(f64(pix))) / pix) * window;
            }
            store<f32>(SINC_PTR + (tap * g_oversample + phase) * 4, val);
        }
    }
}

@inline
function generateDecimationTable(): void {
    // デシメーション用LPF: fc = sampleRate/2（ナイキスト）
    // タップ数 = oversample（128点）、Kaiser窓 β=8
    const cutoff: f32 = f32(1.0); // 1.0 = sr/2 (Nyquist), 0.5 = sr/4
    const center = f32(g_oversample - 1) / f32(2.0);
    let sum: f32 = f32(0.0);

    for (let n = 0; n < g_oversample; n++) {
        const x = f32(n) - center;
        const pix = f32(Math.PI) * x / f32(g_oversample) * cutoff;  // 正規化カットオフ = 1/oversample
        let val: f32;
        if (x == f32(0)) {
            val = f32(1.0);
        } else {
            val = f32(Math.sin(f64(pix))) / pix;
        }
        // Kaiser窓 β=8
        val *= kaiserWindow(n, g_oversample, f32(8.0));
        store<f32>(DECI_PTR + n * 4, val);
        sum += val;
    }
    // 正規化（DC利得=1）
    for (let n = 0; n < g_oversample; n++) {
        store<f32>(DECI_PTR + n * 4, load<f32>(DECI_PTR + n * 4) / sum);
    }
}

export function init(taps: i32, sampleRate: f32): void {
    g_taps = taps;
    g_tapsMask = taps - 1;
    g_sampleRate = sampleRate;

    // oversampleFactorをWasm内で計算（processor.jsと同じロジック）
    const baseRate: f32 = (g_sampleRate % f32(44100) == f32(0))
        ? f32(44100) : f32(48000);
    const targetRate: f32 = baseRate * f32(128);
    const raw: i32 = i32(Math.round(f64(targetRate / g_sampleRate)));
    // 4の倍数に切り上げ
    g_oversample = ((raw + 3) >> 2) << 2;

    b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(4000)) / g_sampleRate), 2));
    b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(8000)) / g_sampleRate), 2));
    b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(14000)) / g_sampleRate), 2));

    // ハイパスフィルタの係数計算（カットオフ周波数 fc を指定）
    // 1次後退差分による簡易HPF係数// カットオフ周波数 Hz（10kHz）
    g_hpCoeff = f32(1.0) - f32(2.0) * f32(Math.PI) * f32(800.0) / (g_sampleRate * f32(g_oversample));

    // Polyphaseテーブル生成
    generatePolyphaseTable();
    // デシメーション用テーブル生成
    generateDecimationTable();
    // 状態初期化
    resetState();
}

export function resetState(): void {
    // 積分器・AGC・履歴をすべてゼロクリア
    // stateは13要素×4byte=52byte、historyはtaps要素×4byte
    for (let n: usize = 0; n < 13 * 4; n += 4) {
        store<f32>(STATE_L + n, f32(0.0));
        store<f32>(STATE_R + n, f32(0.0));
    }
    // writePosはi32として明示的にゼロクリア
    store<i32>(STATE_L + 48, 0);
    store<i32>(STATE_R + 48, 0);
    // 履歴バッファ
    for (let n: usize = 0; n < usize(g_taps) * 4; n += 4) {
        store<f32>(HIST_L + n, f32(0.0));
        store<f32>(HIST_R + n, f32(0.0));
    }
    // デシメーション用FBバッファ
    for (let n: usize = 0; n < usize(g_oversample) * 4; n += 4) {
        store<f32>(FB_BUF_L + n, f32(0.0));
        store<f32>(FB_BUF_R + n, f32(0.0));
    }
}

@inline
function processChannel(
    len: i32, aggression: f32, targetLevel: f32, expansionDepth: f32, exciteAmount: f32,
    inP: usize, outP: usize, histP: usize, sP: usize, fbP: usize
): void {

    const G1 = aggression;
    const G2 = G1 * f32(0.75); const G3 = G2 * f32(0.55);
    const G4 = G3 * f32(0.35); const G5 = G4 * f32(0.20);
    const G6 = G5 * f32(0.15); const G7 = G6 * f32(0.10);

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
        const a: f32 = s < f32(0.0) ? -s : s;
        // select: aがblockPeakより大きければa、そうでなければblockPeak
        blockPeak = a > blockPeak ? a : blockPeak;
        blockRMS += s * s;
    }
    blockRMS = f32(Math.sqrt(f64(blockRMS / f32(len))));

    // ピーク/RMS追従: ifをなくし乗算で統一
    // blockPeak > curPeak のとき: blockPeak
    // そうでないとき:             curPeak += (blockPeak - curPeak) * 0.0001
    // → 両方計算して選択（条件移動命令に最適化される）
    const peakRelease = curPeak + (blockPeak - curPeak) * f32(0.0001);
    curPeak = blockPeak > curPeak ? blockPeak : peakRelease;

    const rmsRelease = curRMS + (blockRMS - curRMS) * f32(0.00005);
    curRMS = blockRMS > curRMS ? blockRMS : rmsRelease;

    // 3. ゲインの計算 (冪乗カーブを含む)
    const safePeak: f32 = curPeak > f32(0.01) ? curPeak : f32(0.01);
    const safeRMS: f32 = curRMS > f32(0.005) ? curRMS : f32(0.005);
    const baseGain = targetLevel / safePeak;
    const expansionFactor = f32(Math.pow(f64(safePeak), f64(expansionDepth - f32(1.0))));
    // RMSが小さい時（残響・弱音）に動作点を上げる補正
    // RMSが低いほど追加ゲインがかかる、ただし上限を設ける
    const rmsBoost: f32 = f32(0.25) / safeRMS < f32(2.0) ? f32(0.25) / safeRMS : f32(2.0);

    const targetGain = f32(baseGain * expansionFactor) * rmsBoost;

    // 前回のゲインから緩やかに遷移させるためのステップ
    // lastGain==0のとき targetGainを使う → lastGain + (targetGain-lastGain)*(lastGain==0?1:0)
    // AssemblyScriptではselect組み込みが使える
    lastGain = select<f32>(targetGain, lastGain, lastGain == f32(0));
    let gainStep = (targetGain - lastGain) / f32(len);
    let currentGain = lastGain;

    for (let i = 0; i < len; i++) {
        currentGain += gainStep;
        store<f32>(histP + writePos * 4, load<f32>(inP + i * 4) * currentGain);
        const newestPos = writePos;
        writePos = (writePos + 1) & g_tapsMask;

        let vAcc = f32x4.splat(0.0); // 4位相分のアキュムレータ

        for (let j = 0; j < g_oversample; j += 4) {
            vAcc = f32x4.splat(0.0);

            for (let k = 0; k < g_taps; k++) {
                let bufIdx: i32 = (newestPos - k + g_taps) & g_tapsMask;
                let h: f32 = load<f32>(histP + bufIdx * 4);
                // transTable[k * oversample + j] の4要素を一括ロード
                let coeff = v128.load(SINC_PTR + (k * g_oversample + j) * 4);
                vAcc = f32x4.add(vAcc, f32x4.mul(f32x4.splat(h), coeff));
            }

            // 4サブサンプルをΔΣに投入
            for (let sub = 0; sub < 4; sub++) {
                let x: f32 = sub == 0 ? f32x4.extract_lane(vAcc, 0) :
                    sub == 1 ? f32x4.extract_lane(vAcc, 1) :
                        sub == 2 ? f32x4.extract_lane(vAcc, 2) :
                            f32x4.extract_lane(vAcc, 3);

                // HPFで高域成分を取り出す
                let hp: f32 = x - hpState;
                hpState = hpState * g_hpCoeff + x * (f32(1.0) - g_hpCoeff);
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
                fb = i1 * W1 + i2 * W2 + i3 * W3 + i4 * W4 + i5 * W5 + i6 * W6 + i7 * W7;

                // fbを別バッファに蓄積してからFIR
                let fbBufIdx = j + sub;  // 0〜oversample-1
                store<f32>(fbP + fbBufIdx * 4, fb);

            }
        }

        if (isNaN(i1) || f32(Math.abs(i1)) > f32(2.0)) {
            i1 = i2 = i3 = i4 = i5 = i6 = i7 = fb = f32(0.0);
        }
        let out: f32 = f32(0.0);
        for (let n = 0; n < g_oversample; n++) {
            out += load<f32>(fbP + n * 4) * load<f32>(DECI_PTR + n * 4);
        }
        store<f32>(outP + i * 4, out / currentGain);
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

export function process_simd(len: i32, aggression: f32, targetLevel: f32, expansionDepth: f32, exciteAmount: f32): void {
    // LとRを明示的に個別呼び出し
    processChannel(
        len, aggression, targetLevel, expansionDepth, exciteAmount,
        INPUT_L, OUTPUT_L, HIST_L, STATE_L, FB_BUF_L
    );
    processChannel(
        len, aggression, targetLevel, expansionDepth, exciteAmount,
        INPUT_R, OUTPUT_R, HIST_R, STATE_R, FB_BUF_R
    );
}
