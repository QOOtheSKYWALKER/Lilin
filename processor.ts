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

// 固定メモリアドレス（16byteアライメント保証）
// 8KB以降から開始（ASランタイム領域を確実に避ける）
const INPUT_L: usize = 8192;   // 512byte
const INPUT_R: usize = 8704;   // 512byte
const OUTPUT_L: usize = 9216;   // 512byte
const OUTPUT_R: usize = 9728;   // 512byte
const SINC_PTR: usize = 10240;   // 65536byte（128tap×128oversample×4byte）
const DECI_PTR: usize = 76288;  // 512byte（128oversample×4byte）
const FB_BUF_L: usize = 76800;  // 512byte
const FB_BUF_R: usize = 77312;  // 512byte
const HIST_L: usize = 77824;  // 512byte（128tap×4byte）
const HIST_R: usize = 78336;  // 512byte
const STATE_L: usize = 78848;  // 52byte（13要素×4byte）
const STATE_R: usize = 78912;  // 52byte（16byteアライメントで78912）
// 総使用量: 78,964 byte ≈ 77KB（2Wasmページ以内）
// 最大128oversample, 128tapsに対応。増やす場合はアドレス修正が必要

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
    const baseRate: f32 = (g_sampleRate % f32(44100) == f32(0)) ? f32(44100) : f32(48000);
    const targetRate: f32 = baseRate * f32(128);
    const raw: i32 = i32(Math.round(f64(targetRate / g_sampleRate)));
    // 4の倍数に切り上げ
    g_oversample = ((raw + 3) >> 2) << 2;

    b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(4000)) / g_sampleRate), 2));
    b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(8000)) / g_sampleRate), 2));
    b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(14000)) / g_sampleRate), 2));

    // ハイパスフィルタの係数計算（カットオフ周波数 fc を指定）
    // 1次後退差分による簡易HPF係数// カットオフ周波数 Hz（1kHz）
    g_hpCoeff = f32(1.0) - f32(2.0) * f32(Math.PI) * f32(1000.0) / (g_sampleRate * f32(g_oversample));

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
    for (let n: usize = 0; n < 12 * 4; n += 4) {
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
function pack2(l: f32, r: f32): v128 {
    return f32x4.replace_lane(f32x4.replace_lane(f32x4.splat(0), 0, l), 1, r);
    // lane0=l, lane1=r, lane2=0, lane3=0
}

export function process_simd(len: i32, aggression: f32, expansionDepth: f32, exciteAmount: f32): void {
    const G1 = aggression;
    const G2 = G1 * f32(0.75);
    const G3 = G2 * f32(0.55);
    const G4 = G3 * f32(0.35);
    const G5 = G4 * f32(0.20);
    const G6 = G5 * f32(0.15);
    const G7 = G6 * f32(0.10);

    const v_G1 = f32x4.splat(G1); const v_G2 = f32x4.splat(G2); const v_G3 = f32x4.splat(G3);
    const v_G4 = f32x4.splat(G4); const v_G5 = f32x4.splat(G5); const v_G6 = f32x4.splat(G6); const v_G7 = f32x4.splat(G7);
    const v_b1 = f32x4.splat(b1); const v_b2 = f32x4.splat(b2); const v_b3 = f32x4.splat(b3);
    const v_W1 = f32x4.splat(W1); const v_W2 = f32x4.splat(W2); const v_W3 = f32x4.splat(W3);
    const v_W4 = f32x4.splat(W4); const v_W5 = f32x4.splat(W5); const v_W6 = f32x4.splat(W6); const v_W7 = f32x4.splat(W7);
    const v_hpC = f32x4.splat(g_hpCoeff); const v_lpC = f32x4.splat(f32(1.0) - g_hpCoeff);
    const v_exAmt = f32x4.splat(exciteAmount);

    // Load States
    let v_i1 = pack2(load<f32>(STATE_L + 0), load<f32>(STATE_R + 0));
    let v_i2 = pack2(load<f32>(STATE_L + 4), load<f32>(STATE_R + 4));
    let v_i3 = pack2(load<f32>(STATE_L + 8), load<f32>(STATE_R + 8));
    let v_i4 = pack2(load<f32>(STATE_L + 12), load<f32>(STATE_R + 12));
    let v_i5 = pack2(load<f32>(STATE_L + 16), load<f32>(STATE_R + 16));
    let v_i6 = pack2(load<f32>(STATE_L + 20), load<f32>(STATE_R + 20));
    let v_i7 = pack2(load<f32>(STATE_L + 24), load<f32>(STATE_R + 24));
    let v_fb = pack2(load<f32>(STATE_L + 28), load<f32>(STATE_R + 28));
    let v_curPeak = pack2(load<f32>(STATE_L + 32), load<f32>(STATE_R + 32));
    let v_lastGain = pack2(load<f32>(STATE_L + 36), load<f32>(STATE_R + 36));
    let v_hpState = pack2(load<f32>(STATE_L + 40), load<f32>(STATE_R + 40));
    let v_curRMS = pack2(load<f32>(STATE_L + 44), load<f32>(STATE_R + 44));
    let writePos_L = load<i32>(STATE_L + 48);
    let writePos_R = load<i32>(STATE_R + 48);

    // Block AGC
    let v_blockPeak = f32x4.splat(0);
    let v_blockRMS = f32x4.splat(0);
    for (let i = 0; i < len; i++) {
        let v_s = pack2(load<f32>(INPUT_L + i * 4), load<f32>(INPUT_R + i * 4));
        let v_a = f32x4.abs(v_s);
        v_blockPeak = f32x4.max(v_blockPeak, v_a);
        v_blockRMS = f32x4.add(v_blockRMS, f32x4.mul(v_s, v_s));
    }
    v_blockRMS = f32x4.sqrt(f32x4.div(v_blockRMS, f32x4.splat(f32(len))));

    // AGC Update
    let v_peakRel = f32x4.add(v_curPeak, f32x4.mul(f32x4.sub(v_blockPeak, v_curPeak), f32x4.splat(0.0001)));
    v_curPeak = f32x4.max(v_blockPeak, v_peakRel);
    let v_rmsRel = f32x4.add(v_curRMS, f32x4.mul(f32x4.sub(v_blockRMS, v_curRMS), f32x4.splat(0.00005)));
    v_curRMS = f32x4.max(v_blockRMS, v_rmsRel);

    let v_safeRMS = f32x4.max(v_curRMS, f32x4.splat(0.005));
    let expL = f32(Math.pow(f64(f32x4.extract_lane(v_curPeak, 0) / f32(0.5)), f64(expansionDepth - f32(1.0))));
    let expR = f32(Math.pow(f64(f32x4.extract_lane(v_curPeak, 1) / f32(0.5)), f64(expansionDepth - f32(1.0))));
    let v_expFact = pack2(expL, expR);
    let v_rmsBoostRaw = f32x4.div(f32x4.splat(0.25), v_safeRMS);
    let v_rmsBoost = f32x4.max(f32x4.splat(1.0), f32x4.min(v_rmsBoostRaw, f32x4.splat(2.0)));
    let v_currentGain = f32x4.mul(v_expFact, v_rmsBoost);

    for (let i = 0; i < len; i++) {
        v_lastGain = f32x4.add(v_lastGain, f32x4.mul(f32x4.sub(v_currentGain, v_lastGain), f32x4.splat(0.1)));
        let v_inRaw = pack2(load<f32>(INPUT_L + i * 4), load<f32>(INPUT_R + i * 4));
        let v_in = f32x4.mul(v_inRaw, v_lastGain);
        store<f32>(HIST_L + writePos_L * 4, f32x4.extract_lane(v_in, 0));
        store<f32>(HIST_R + writePos_R * 4, f32x4.extract_lane(v_in, 1));
        const nPL = writePos_L; const nPR = writePos_R;
        writePos_L = (writePos_L + 1) & g_tapsMask;
        writePos_R = (writePos_R + 1) & g_tapsMask;

        // --- Delta-Sigma Sequential Processing (4 phases) ---
        for (let j = 0; j < g_oversample; j += 4) {

            // FIR: 4位相同時計算（LR独立）
            let v_accL = f32x4.splat(0);
            let v_accR = f32x4.splat(0);
            for (let k = 0; k < g_taps; k++) {
                const hL = load<f32>(HIST_L + ((nPL - k + g_taps) & g_tapsMask) * 4);
                const hR = load<f32>(HIST_R + ((nPR - k + g_taps) & g_tapsMask) * 4);
                const v_c = load<v128>(SINC_PTR + (k * g_oversample + j) * 4);
                v_accL = f32x4.add(v_accL, f32x4.mul(f32x4.splat(hL), v_c));
                v_accR = f32x4.add(v_accR, f32x4.mul(f32x4.splat(hR), v_c));
            }

            // 4サブサンプルのΔΣ（lane0=L, lane1=R で処理）
            for (let sub = 0; sub < 4; sub++) {
                let v_x = pack2(
                    sub == 0 ? f32x4.extract_lane(v_accL, 0) :
                        sub == 1 ? f32x4.extract_lane(v_accL, 1) :
                            sub == 2 ? f32x4.extract_lane(v_accL, 2) :
                                f32x4.extract_lane(v_accL, 3),
                    sub == 0 ? f32x4.extract_lane(v_accR, 0) :
                        sub == 1 ? f32x4.extract_lane(v_accR, 1) :
                            sub == 2 ? f32x4.extract_lane(v_accR, 2) :
                                f32x4.extract_lane(v_accR, 3)
                );

                let v_hp = f32x4.sub(v_x, v_hpState);
                v_hpState = f32x4.add(f32x4.mul(v_hpState, v_hpC), f32x4.mul(v_x, v_lpC));
                let v_xEx = f32x4.add(v_x, f32x4.mul(v_hp, v_exAmt));

                let v_delta = f32x4.sub(v_xEx, v_fb);
                v_i1 = f32x4.add(v_i1, f32x4.mul(v_delta, v_G1));
                v_i2 = f32x4.add(v_i2, f32x4.mul(f32x4.sub(v_i1, f32x4.mul(v_i3, v_b1)), v_G2));
                v_i3 = f32x4.add(v_i3, f32x4.mul(v_i2, v_G3));
                v_i4 = f32x4.add(v_i4, f32x4.mul(f32x4.sub(v_i3, f32x4.mul(v_i5, v_b2)), v_G4));
                v_i5 = f32x4.add(v_i5, f32x4.mul(v_i4, v_G5));
                v_i6 = f32x4.add(v_i6, f32x4.mul(f32x4.sub(v_i5, f32x4.mul(v_i7, v_b3)), v_G6));
                v_i7 = f32x4.add(v_i7, f32x4.mul(v_i6, v_G7));

                let v_sum123 = f32x4.add(f32x4.mul(v_i1, v_W1), f32x4.add(f32x4.mul(v_i2, v_W2), f32x4.mul(v_i3, v_W3)));
                let v_sum456 = f32x4.add(f32x4.mul(v_i4, v_W4), f32x4.add(f32x4.mul(v_i5, v_W5), f32x4.mul(v_i6, v_W6)));
                v_fb = f32x4.add(v_sum123, f32x4.add(v_sum456, f32x4.mul(v_i7, v_W7)));

                // FB_BUFに蓄積
                const fbIdx = j + sub;
                store<f32>(FB_BUF_L + fbIdx * 4, f32x4.extract_lane(v_fb, 0));
                store<f32>(FB_BUF_R + fbIdx * 4, f32x4.extract_lane(v_fb, 1));
            }
        }

        // Robust NaN protection
        if (isNaN(f32x4.extract_lane(v_i1, 0)) || isNaN(f32x4.extract_lane(v_i1, 1))) {
            v_i1 = v_i2 = v_i3 = v_i4 = v_i5 = v_i6 = v_i7 = v_fb = v_hpState = f32x4.splat(0);
        }

        // デシメーション（全oversample点を使う）
        let sumL: f32 = 0;
        let sumR: f32 = 0;
        for (let n = 0; n < g_oversample; n += 4) {
            const v_fbL4 = load<v128>(FB_BUF_L + n * 4);
            const v_fbR4 = load<v128>(FB_BUF_R + n * 4);
            const v_d = load<v128>(DECI_PTR + n * 4);
            const v_pL = f32x4.mul(v_fbL4, v_d);
            const v_pR = f32x4.mul(v_fbR4, v_d);
            sumL += f32x4.extract_lane(v_pL, 0) + f32x4.extract_lane(v_pL, 1)
                + f32x4.extract_lane(v_pL, 2) + f32x4.extract_lane(v_pL, 3);
            sumR += f32x4.extract_lane(v_pR, 0) + f32x4.extract_lane(v_pR, 1)
                + f32x4.extract_lane(v_pR, 2) + f32x4.extract_lane(v_pR, 3);
        }
        store<f32>(OUTPUT_L + i * 4, sumL);
        store<f32>(OUTPUT_R + i * 4, sumR);
    }

    store<f32>(STATE_L + 0, f32x4.extract_lane(v_i1, 0)); store<f32>(STATE_R + 0, f32x4.extract_lane(v_i1, 1));
    store<f32>(STATE_L + 4, f32x4.extract_lane(v_i2, 0)); store<f32>(STATE_R + 4, f32x4.extract_lane(v_i2, 1));
    store<f32>(STATE_L + 8, f32x4.extract_lane(v_i3, 0)); store<f32>(STATE_R + 8, f32x4.extract_lane(v_i3, 1));
    store<f32>(STATE_L + 12, f32x4.extract_lane(v_i4, 0)); store<f32>(STATE_R + 12, f32x4.extract_lane(v_i4, 1));
    store<f32>(STATE_L + 16, f32x4.extract_lane(v_i5, 0)); store<f32>(STATE_R + 16, f32x4.extract_lane(v_i5, 1));
    store<f32>(STATE_L + 20, f32x4.extract_lane(v_i6, 0)); store<f32>(STATE_R + 20, f32x4.extract_lane(v_i6, 1));
    store<f32>(STATE_L + 24, f32x4.extract_lane(v_i7, 0)); store<f32>(STATE_R + 24, f32x4.extract_lane(v_i7, 1));
    store<f32>(STATE_L + 28, f32x4.extract_lane(v_fb, 0)); store<f32>(STATE_R + 28, f32x4.extract_lane(v_fb, 1));
    store<f32>(STATE_L + 32, f32x4.extract_lane(v_curPeak, 0)); store<f32>(STATE_R + 32, f32x4.extract_lane(v_curPeak, 1));
    store<f32>(STATE_L + 36, f32x4.extract_lane(v_lastGain, 0)); store<f32>(STATE_R + 36, f32x4.extract_lane(v_lastGain, 1));
    store<f32>(STATE_L + 40, f32x4.extract_lane(v_hpState, 0)); store<f32>(STATE_R + 40, f32x4.extract_lane(v_hpState, 1));
    store<f32>(STATE_L + 44, f32x4.extract_lane(v_curRMS, 0)); store<f32>(STATE_R + 44, f32x4.extract_lane(v_curRMS, 1));
    store<i32>(STATE_L + 48, writePos_L); store<i32>(STATE_R + 48, writePos_R);
}
