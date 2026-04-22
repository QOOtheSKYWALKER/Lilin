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

// === Wasm内部グローバル（JSから触らない） ===
let G1: f32 = 0.0; let G2: f32 = 0.0; let G3: f32 = 0.0;
let G4: f32 = 0.0; let G5: f32 = 0.0; let G6: f32 = 0.0; let G7: f32 = 0.0;
let b1: f32 = 0.0; let b2: f32 = 0.0; let b3: f32 = 0.0;

const g_taps: i32 = 128;
const g_tapsMask: i32 = 127;
let g_oversample: i32 = 0;
let g_weightTotalConst: f32 = 0.0;
let g_sampleRate: f32 = 0.0;
let g_hpCoeff: f32 = 0.0;
let g_targetLevel: f32 = 0.0;
let g_expansionDepth: f32 = 0.0;
let g_exciteAmount: f32 = 0.0;

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

@inline
function hardClip(x: f32): f32 {
    // f32.min/maxはWasmのネイティブ命令に直接マップされ分岐なし
    const c1: f32 = x > f32(1.0) ? f32(1.0) : x;
    return c1 < f32(-1.0) ? f32(-1.0) : c1;
    // ※ AssemblyScriptのmin/maxはNaN伝播の仕様が異なるため
    //    三項演算子版が最も安全かつifより高速（条件移動命令CMOVに最適化される）
}

// 新レイアウト: transTable[k * oversample + j]
// → kループ内で j方向に連続アクセス可能
//
// cutoff = 0.5 → カットオフを sampleRate/4 に設定
// （1.0 = Nyquist = sampleRate/2 に対して半分）
// sinc引数を cutoff 倍してカットオフを下げ、
// 係数全体に cutoff を乗じて通過帯域ゲインを 1.0 に維持する。
// これにより sampleRate/4 以上の折り返し成分を除去できる。
@inline
function generatePolyphaseTable(): void {
    const cutoff: f32 = f32(0.5); // 1.0 = sr/2 (Nyquist), 0.5 = sr/4
    const size = g_oversample * g_taps;
    const center = (g_taps / 2) * g_oversample;
    for (let tap = 0; tap < g_taps; tap++) {
        for (let phase = 0; phase < g_oversample; phase++) {
            const i = tap * g_oversample + phase;
            // Scale the sinc argument by cutoff to lower the passband edge
            const xf = f32(i - center) / f32(g_oversample) * cutoff;
            const pix = f32(Math.PI) * xf;
            const window = f32(0.42)
                - f32(0.5) * f32(Math.cos(f64(f32(2.0) * f32(Math.PI) * f32(i) / f32(size - 1))))
                + f32(0.08) * f32(Math.cos(f64(f32(4.0) * f32(Math.PI) * f32(i) / f32(size - 1))));
            let val: f32;
            if (xf == f32(0)) {
                // Center tap: sinc(0) = 1, multiply by cutoff to normalize passband gain
                val = cutoff;
            } else {
                // Multiply by cutoff to restore unity passband gain
                val = cutoff * (f32(Math.sin(f64(pix))) / pix) * window;
            }
            store<f32>(SINC_PTR + (tap * g_oversample + phase) * 4, val);
        }
    }
}

export function init(sampleRate: f32, aggression: f32, targetLevel: f32, expansionDepth: f32, exciteAmount: f32): void {
    g_sampleRate = sampleRate;
    g_targetLevel = targetLevel;
    g_expansionDepth = expansionDepth;
    g_exciteAmount = exciteAmount;

    // oversampleFactorをWasm内で計算（processor.jsと同じロジック）
    const baseRate: f32 = (g_sampleRate % f32(44100) == f32(0))
        ? f32(44100) : f32(48000);
    const targetRate: f32 = baseRate * f32(128);
    const raw: i32 = i32(Math.round(f64(targetRate / g_sampleRate)));
    // 4の倍数に切り上げ
    g_oversample = ((raw + 3) >> 2) << 2;

    // weightTotalConstを計算
    g_weightTotalConst = f32(0.0);
    for (let jj = 0; jj < g_oversample; jj++) {
        g_weightTotalConst += f32(jj) * (f32(g_oversample) - f32(jj));
    }

    G1 = aggression;
    G2 = G1 * f32(0.75); G3 = G2 * f32(0.55);
    G4 = G3 * f32(0.35); G5 = G4 * f32(0.20);
    G6 = G5 * f32(0.15); G7 = G6 * f32(0.10);

    b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(4000)) / g_sampleRate), 2));
    b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(8000)) / g_sampleRate), 2));
    b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(14000)) / g_sampleRate), 2));

    // ハイパスフィルタの係数計算（カットオフ周波数 fc を指定）
    // 1次後退差分による簡易HPF係数// カットオフ周波数 Hz（10kHz）
    g_hpCoeff = f32(1.0) - f32(2.0) * f32(Math.PI) * f32(4000.0) / (g_sampleRate * f32(g_oversample));

    // Polyphaseテーブル生成
    generatePolyphaseTable();
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
}

@inline
function processChannel(
    len: i32,
    inP: usize, outP: usize, histP: usize, sP: usize,
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
        const a: f32 = s < f32(0.0) ? -s : s;
        // select: aがblockPeakより大きければa、そうでなければblockPeak
        blockPeak = a > blockPeak ? a : blockPeak;
        blockRMS += s * s;
    }
    blockRMS = f32(Math.sqrt(f64(blockRMS / f32(len))));

    // ピーク/RMS追従: ifをなくし乗算で統一
    // blockPeak > curPeak のとき: curPeak = blockPeak * 1.1
    // そうでないとき:             curPeak += (blockPeak - curPeak) * 0.0001
    // → 両方計算して選択（条件移動命令に最適化される）
    const peakAttack = blockPeak * f32(1.1);
    const peakRelease = curPeak + (blockPeak - curPeak) * f32(0.0001);
    curPeak = blockPeak > curPeak ? peakAttack : peakRelease;

    const rmsAttack = blockRMS * f32(1.05);
    const rmsRelease = curRMS + (blockRMS - curRMS) * f32(0.00005);
    curRMS = blockRMS > curRMS ? rmsAttack : rmsRelease;

    // 3. ゲインの計算 (冪乗カーブを含む)
    const safePeak: f32 = curPeak > f32(0.01) ? curPeak : f32(0.01);
    const safeRMS: f32 = curRMS > f32(0.005) ? curRMS : f32(0.005);
    const baseGain = g_targetLevel / safePeak;
    const expansionFactor = f32(Math.pow(f64(safePeak), f64(g_expansionDepth - f32(1.0))));
    // RMSが小さい時（残響・弱音）に動作点を上げる補正
    // RMSが低いほど追加ゲインがかかる、ただし上限を設ける
    const rmsBoost: f32 = f32(0.15) / safeRMS < f32(1.4) ? f32(0.15) / safeRMS : f32(1.4);

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

        let scalarAcc: f32 = 0.0; // デシメーション用スカラー累積

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

                // 1. HPFで高域成分を取り出す（現在の実装を継続）
                let hp: f32 = x - hpState;
                hpState = hpState * g_hpCoeff + x * (f32(1.0) - g_hpCoeff);
                let x_excited: f32 = x + hp * g_exciteAmount;

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
                scalarAcc += fb * jj * (f32(g_oversample) - jj);
            }
        }

        if (isNaN(i1) || f32(Math.abs(i1)) > f32(8.0)) {
            i1 = i2 = i3 = i4 = i5 = i6 = i7 = fb = f32(0.0);
        }
        store<f32>(outP + i * 4, scalarAcc / g_weightTotalConst / currentGain);
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

export function process_simd(len: i32): void {
    // LとRを明示的に個別呼び出し
    processChannel(
        len,
        INPUT_L, OUTPUT_L, HIST_L, STATE_L
    );
    processChannel(
        len,
        INPUT_R, OUTPUT_R, HIST_R, STATE_R
    );
}
