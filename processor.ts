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

const W1 = f32x4.splat(0.90); const W2 = f32x4.splat(0.75); const W3 = f32x4.splat(0.25);
const W4 = f32x4.splat(0.18); const W5 = f32x4.splat(0.12); const W6 = f32x4.splat(0.07); const W7 = f32x4.splat(0.05);

const G1 = f32x4.splat(1.20);
const G2 = f32x4.mul(G1, f32x4.splat(0.80));
const G3 = f32x4.mul(G2, f32x4.splat(0.60));
const G4 = f32x4.mul(G3, f32x4.splat(0.40));
const G5 = f32x4.mul(G4, f32x4.splat(0.20));
const G6 = f32x4.mul(G5, f32x4.splat(0.15));
const G7 = f32x4.mul(G6, f32x4.splat(0.10));

let g_taps: i32; let g_tapsMask: i32;
let g_oversample: i32; let g_hpCoeff: f32;

// --- Module-level DSP integrator state (used by processDeltaSigmaPhase) ---
let i1: v128; let i2: v128; let i3: v128; let i4: v128;
let i5: v128; let i6: v128; let i7: v128; let fb: v128;
let b1: v128; let b2: v128; let b3: v128; let v_hpState: v128;

// Fixed memory addresses for JS interop (Zero-copy region)
const INPUT_L: usize = 8192;
const INPUT_R: usize = 8704;
const OUTPUT_L: usize = 9216;
const OUTPUT_R: usize = 9728;
const STATE: usize = 16384;  // Start at 16KB for safety

// Internal DSP buffer pointers (Dynamically allocated in init)
let HIST_L: usize;
let HIST_R: usize;
let FB_BUF_L: usize;
let FB_BUF_R: usize;
let DECI_PTR: usize;
let SINC_PTR: usize;

@inline
function align16(addr: usize): usize {
    return (addr + 15) & ~15;
}

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
    const cutoff: f32 = f32(1.0);
    const center: f32 = f32(g_taps - 1) / f32(2.0);

    for (let tap = 0; tap < g_taps; tap++) {
        for (let phase = 0; phase < g_oversample; phase++) {
            // 位相（0..1）を考慮した中心からの距離
            // 時間が進む（phaseが増える）につれて前進するため「+」が正解
            const xf = (f32(tap) - center + f32(phase) / f32(g_oversample)) * cutoff;
            const pix = f32(Math.PI) * xf;
            const window = kaiserWindow(tap, g_taps, f32(8.0));

            let val: f32;
            if (xf == f32(0)) {
                val = cutoff * window;
            } else {
                val = cutoff * (f32(Math.sin(f64(pix))) / pix) * window;
            }
            // 各タップの各フェーズにストア（SIMDロード用にフェーズを連続させる）
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

export function init(taps: i32, oversample: i32, sampleRate: f32): void {
    g_taps = taps;
    g_tapsMask = taps - 1;

    // oversampleFactorをWasm内で計算（processor.jsと同じロジック）
    const baseRate: f32 = (sampleRate % f32(44100) == f32(0)) ? f32(44100) : f32(48000);
    const targetRate: f32 = baseRate * f32(oversample);
    const raw: i32 = i32(Math.round(f64(targetRate / sampleRate)));
    // 4の倍数に切り上げ
    g_oversample = ((raw + 3) >> 2) << 2;

    // --- Dynamic Memory Allocation ---
    let ptr = align16(STATE + 200);
    HIST_L = ptr; ptr = align16(ptr + (g_taps * 4));
    HIST_R = ptr; ptr = align16(ptr + (g_taps * 4));
    FB_BUF_L = ptr; ptr = align16(ptr + (g_oversample * 4));
    FB_BUF_R = ptr; ptr = align16(ptr + (g_oversample * 4));
    DECI_PTR = ptr; ptr = align16(ptr + (g_oversample * 4));
    SINC_PTR = ptr; // Large table at the end

    b1 = f32x4.splat(f32(Math.pow(f64((f32(Math.PI) * f32(2 * 4000)) / sampleRate), 2)));
    b2 = f32x4.splat(f32(Math.pow(f64((f32(Math.PI) * f32(2 * 8000)) / sampleRate), 2)));
    b3 = f32x4.splat(f32(Math.pow(f64((f32(Math.PI) * f32(2 * 12000)) / sampleRate), 2)));

    // ハイパスフィルタの係数計算（カットオフ周波数 fc を指定）
    // 1次後退差分による簡易HPF係数// カットオフ周波数 Hz（1kHz）
    g_hpCoeff = f32(1.0) - f32(Math.PI) * f32(2 * 1000.0) / (sampleRate * f32(g_oversample));

    // Polyphaseテーブル生成
    generatePolyphaseTable();
    // デシメーション用テーブル生成
    generateDecimationTable();
    // 状態初期化
    resetState();
}

export function resetState(): void {
    // Clear all integrators and AGC states (12 v128 slots + writePos = 200 bytes)
    for (let n: usize = 0; n < 200; n += 4) {
        store<f32>(STATE + n, f32(0.0));
    }
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

// Process one Delta-Sigma phase.
@inline
function processDeltaSigmaPhase(v_x: v128, exciteAmount: f32): void {

    // ダイナミック・エキスパンダー（高域強調）
    const v_hp = f32x4.sub(v_x, v_hpState);
    v_hpState = f32x4.add(f32x4.mul(v_hpState, f32x4.splat(g_hpCoeff)), f32x4.mul(v_x, f32x4.splat(f32(1.0) - g_hpCoeff)));
    const v_xEx = f32x4.add(v_x, f32x4.mul(v_hp, f32x4.splat(exciteAmount)));

    // ΔΣ変調
    const v_delta = f32x4.sub(v_xEx, fb);
    i1 = f32x4.add(i1, f32x4.mul(v_delta, G1));
    i2 = f32x4.add(i2, f32x4.mul(f32x4.sub(i1, f32x4.mul(i3, b1)), G2));
    i3 = f32x4.add(i3, f32x4.mul(i2, G3));
    i4 = f32x4.add(i4, f32x4.mul(f32x4.sub(i3, f32x4.mul(i5, b2)), G4));
    i5 = f32x4.add(i5, f32x4.mul(i4, G5));
    i6 = f32x4.add(i6, f32x4.mul(f32x4.sub(i5, f32x4.mul(i7, b3)), G6));
    i7 = f32x4.add(i7, f32x4.mul(i6, G7));
    fb = f32x4.add(
        f32x4.add(f32x4.mul(i1, W1), f32x4.add(f32x4.mul(i2, W2), f32x4.mul(i3, W3))),
        f32x4.add(f32x4.add(f32x4.mul(i4, W4), f32x4.add(f32x4.mul(i5, W5), f32x4.mul(i6, W6))),
            f32x4.mul(i7, W7)));
}

export function process_simd(len: i32, expansionDepth: f32, exciteAmount: f32): void {

    // Load States from interleaved STATE buffer (one v128 load per variable)
    i1 = load<v128>(STATE + 0);
    i2 = load<v128>(STATE + 16);
    i3 = load<v128>(STATE + 32);
    i4 = load<v128>(STATE + 48);
    i5 = load<v128>(STATE + 64);
    i6 = load<v128>(STATE + 80);
    i7 = load<v128>(STATE + 96);
    fb = load<v128>(STATE + 112);
    let v_curPeak = load<v128>(STATE + 128);
    let v_lastGain = load<v128>(STATE + 144);
    v_hpState = load<v128>(STATE + 160);
    let v_curRMS = load<v128>(STATE + 176);
    let writePos_L = load<i32>(STATE + 192);
    let writePos_R = load<i32>(STATE + 196);

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
    const v_peakRel = f32x4.add(v_curPeak, f32x4.mul(f32x4.sub(v_blockPeak, v_curPeak), f32x4.splat(0.0001)));
    v_curPeak = f32x4.max(v_blockPeak, v_peakRel);
    const v_rmsRel = f32x4.add(v_curRMS, f32x4.mul(f32x4.sub(v_blockRMS, v_curRMS), f32x4.splat(0.00005)));
    v_curRMS = f32x4.max(v_blockRMS, v_rmsRel);

    const expL = f32(Math.pow(f64(f32x4.extract_lane(v_curPeak, 0) / f32(0.8)), f64(expansionDepth)));
    const expR = f32(Math.pow(f64(f32x4.extract_lane(v_curPeak, 1) / f32(0.8)), f64(expansionDepth)));
    const v_rmsBoostRaw = f32x4.div(f32x4.splat(0.25), v_curRMS);
    const v_rmsBoost = f32x4.max(f32x4.splat(1.0), f32x4.min(v_rmsBoostRaw, f32x4.splat(2.0)));
    const v_currentGain = f32x4.mul(pack2(expL, expR), v_rmsBoost);

    for (let i = 0; i < len; i++) {
        v_lastGain = f32x4.add(v_lastGain, f32x4.mul(f32x4.sub(v_currentGain, v_lastGain), f32x4.splat(0.005)));
        const v_in = f32x4.mul(pack2(load<f32>(INPUT_L + i * 4), load<f32>(INPUT_R + i * 4)), v_lastGain);
        store<f32>(HIST_L + writePos_L * 4, f32x4.extract_lane(v_in, 0));
        store<f32>(HIST_R + writePos_R * 4, f32x4.extract_lane(v_in, 1));
        const nPL = writePos_L; const nPR = writePos_R;
        writePos_L = (writePos_L + 1) & g_tapsMask;
        writePos_R = (writePos_R + 1) & g_tapsMask;

        // --- FIR + ΔΣ: j ループで4フェーズずつ全 oversample 処理 ---
        for (let j = 0; j < g_oversample; j += 4) {
            // FIR: jオフセット分の4フェーズを一括計算
            let v_accL = f32x4.splat(0);
            let v_accR = f32x4.splat(0);
            for (let k = 0; k < g_taps; k++) {
                const hL = load<f32>(HIST_L + ((nPL - k + g_taps) & g_tapsMask) * 4);
                const hR = load<f32>(HIST_R + ((nPR - k + g_taps) & g_tapsMask) * 4);
                const v_c = load<v128>(SINC_PTR + (k * g_oversample + j) * 4);
                v_accL = f32x4.add(v_accL, f32x4.mul(f32x4.splat(hL), v_c));
                v_accR = f32x4.add(v_accR, f32x4.mul(f32x4.splat(hR), v_c));
            }

            // ΔΣ 4フェーズ アンロール（lane0=L, lane1=R）
            processDeltaSigmaPhase(pack2(f32x4.extract_lane(v_accL, 0), f32x4.extract_lane(v_accR, 0)), exciteAmount);
            store<f32>(FB_BUF_L + (j + 0) * 4, f32x4.extract_lane(fb, 0));
            store<f32>(FB_BUF_R + (j + 0) * 4, f32x4.extract_lane(fb, 1));

            processDeltaSigmaPhase(pack2(f32x4.extract_lane(v_accL, 1), f32x4.extract_lane(v_accR, 1)), exciteAmount);
            store<f32>(FB_BUF_L + (j + 1) * 4, f32x4.extract_lane(fb, 0));
            store<f32>(FB_BUF_R + (j + 1) * 4, f32x4.extract_lane(fb, 1));

            processDeltaSigmaPhase(pack2(f32x4.extract_lane(v_accL, 2), f32x4.extract_lane(v_accR, 2)), exciteAmount);
            store<f32>(FB_BUF_L + (j + 2) * 4, f32x4.extract_lane(fb, 0));
            store<f32>(FB_BUF_R + (j + 2) * 4, f32x4.extract_lane(fb, 1));

            processDeltaSigmaPhase(pack2(f32x4.extract_lane(v_accL, 3), f32x4.extract_lane(v_accR, 3)), exciteAmount);
            store<f32>(FB_BUF_L + (j + 3) * 4, f32x4.extract_lane(fb, 0));
            store<f32>(FB_BUF_R + (j + 3) * 4, f32x4.extract_lane(fb, 1));
        }

        // Robust NaN and divergence protection
        if (isNaN(f32x4.extract_lane(i1, 0)) || isNaN(f32x4.extract_lane(i1, 1))) {
            i1 = i2 = i3 = i4 = i5 = i6 = i7 = fb = v_hpState = f32x4.splat(0);
        }

        // --- デシメーション: SIMD accumulation, single horizontal add ---
        let v_sumL = f32x4.splat(0);
        let v_sumR = f32x4.splat(0);
        for (let n = 0; n < g_oversample; n += 4) {
            const v_d = load<v128>(DECI_PTR + n * 4);
            v_sumL = f32x4.add(v_sumL, f32x4.mul(load<v128>(FB_BUF_L + n * 4), v_d));
            v_sumR = f32x4.add(v_sumR, f32x4.mul(load<v128>(FB_BUF_R + n * 4), v_d));
        }
        // Horizontal add: extract lanes once after loop
        store<f32>(OUTPUT_L + i * 4,
            f32x4.extract_lane(v_sumL, 0) + f32x4.extract_lane(v_sumL, 1) +
            f32x4.extract_lane(v_sumL, 2) + f32x4.extract_lane(v_sumL, 3));
        store<f32>(OUTPUT_R + i * 4,
            f32x4.extract_lane(v_sumR, 0) + f32x4.extract_lane(v_sumR, 1) +
            f32x4.extract_lane(v_sumR, 2) + f32x4.extract_lane(v_sumR, 3));
    }

    // Store States to interleaved STATE buffer (one v128 store per variable)
    store<v128>(STATE + 0, i1);
    store<v128>(STATE + 16, i2);
    store<v128>(STATE + 32, i3);
    store<v128>(STATE + 48, i4);
    store<v128>(STATE + 64, i5);
    store<v128>(STATE + 80, i6);
    store<v128>(STATE + 96, i7);
    store<v128>(STATE + 112, fb);
    store<v128>(STATE + 128, v_curPeak);
    store<v128>(STATE + 144, v_lastGain);
    store<v128>(STATE + 160, v_hpState);
    store<v128>(STATE + 176, v_curRMS);
    store<i32>(STATE + 192, writePos_L);
    store<i32>(STATE + 196, writePos_R);
}
