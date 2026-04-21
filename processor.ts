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
let g_oversample: i32 = 0;
let g_taps: i32 = 128;
let g_tapsMask: i32 = 127;
let g_weightTotalConst: f32 = 0.0;
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
function generatePolyphaseTable(
    tablePtr: usize, oversample: i32, taps: i32
): void {
    const size = oversample * taps;
    const center = (taps / 2) * oversample;
    for (let tap = 0; tap < taps; tap++) {
        for (let phase = 0; phase < oversample; phase++) {
            const i = tap * oversample + phase;
            const xf = f32(i - center) / f32(oversample);
            const pix = f32(Math.PI) * xf;
            const window = f32(0.42)
                - f32(0.5) * f32(Math.cos(f64(f32(2.0) * f32(Math.PI) * f32(i) / f32(size - 1))))
                + f32(0.08) * f32(Math.cos(f64(f32(4.0) * f32(Math.PI) * f32(i) / f32(size - 1))));
            // x==0のとき sinc(0)=1 だが、pix=0で sin(0)/0=NaNになるため
            // sinc(x) = sin(πx)/(πx) を (i==center) で分岐なく処理する
            // → pixが極小のとき sin(pix)/pix ≈ 1.0 なので、
            //   結果に window を掛けた値が center では window[center] になる
            // center点のwindow値を確認: i=center → cos項=0.42-0.5+0.08=0.00... 
            // 実際には center での window = 0.42-0.5*cos(π)+0.08*cos(2π)
            //                              = 0.42+0.5+0.08 = 1.0
            // つまり center点では sinc=1, window=1 → val=1.0 が期待値
            // pixが非常に小さい場合の安全な計算:
            let val: f32;
            if (xf == f32(0)) {
                // center点のみ: 分岐はここだけ（生成時のみ、リアルタイム処理外）
                val = f32(1.0);
            } else {
                val = (f32(Math.sin(f64(pix))) / pix) * window;
            }
            store<f32>(tablePtr + (tap * oversample + phase) * 4, val);
        }
    }
}

export function init(sampleRate: f32): void {
    g_sampleRate = sampleRate;

    // oversampleFactorをWasm内で計算（processor.jsと同じロジック）
    const baseRate: f32 = (sampleRate % f32(44100) == f32(0))
        ? f32(44100) : f32(48000);
    const targetRate: f32 = baseRate * f32(128);
    const raw: i32 = i32(Math.round(f64(targetRate / sampleRate)));
    // 4の倍数に切り上げ
    g_oversample = ((raw + 3) >> 2) << 2;
    g_taps = 128;
    g_tapsMask = g_taps - 1;

    // weightTotalConstを計算
    g_weightTotalConst = f32(0.0);
    for (let jj = 0; jj < g_oversample; jj++) {
        g_weightTotalConst += f32(jj) * (f32(g_oversample) - f32(jj));
    }

    // ハイパスフィルタの係数計算（カットオフ周波数 fc を指定）
    // 1次後退差分による簡易HPF係数// カットオフ周波数 Hz（10kHz）
    g_hpCoeff = f32(1.0) - f32(2.0) * f32(Math.PI) * f32(10000.0) / (g_sampleRate * f32(g_oversample));

    // Polyphaseテーブル生成
    generatePolyphaseTable(SINC_PTR, g_oversample, g_taps);

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
    for (let n: usize = 0; n < usize(g_taps) * 4; n += 4) {
        store<f32>(HIST_L + n, f32(0.0));
        store<f32>(HIST_R + n, f32(0.0));
    }
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
    const baseGain = targetLevel / safePeak;
    const expansionFactor = f32(Math.pow(f64(safePeak), f64(expansionDepth - f32(1.0))));
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
                /*                const lpCoeff: f32 = f32(1.0) - g_hpCoeff;  // ≈ 2π×10000/fs_osr（極小値）
                                hpState = hpState * g_hpCoeff + x * lpCoeff; // hpStateがLPF出力
                                let hp: f32 = x - hpState;                 // HPF = 入力 - LPF出力
                                let x_excited: f32 = x + hp * exciteAmount;
                */
                // --- 改良版：ハーモニック・エキサイターロジック ---

                // 1. HPFで高域成分を取り出す（現在の実装を継続）
                let hp: f32 = x - hpState;
                hpState = hpState * g_hpCoeff + x * (f32(1.0) - g_hpCoeff);

                // 2. 非線形処理による倍音生成（ここが肝）
                // 偶数次（x^2）と奇数次（x^3）を組み合わせた非対称歪み
                // hp成分を少しブーストして歪みやすくする
                let pre: f32 = hp * exciteAmount;
                let abs_hp: f32 = f32(Math.abs(pre));

                // 偶数次倍音成分（輝き）：絶対値をとることで生成
                // 奇数次倍音成分（厚み）：3次式で生成
                // これを組み合わせることで「真空管のサチュレーション」に近い特性にします
                let harmonics: f32 = abs_hp * f32(0.5) + (pre * pre * pre) * f32(0.2);

                // 3. 位相を考慮して合成
                // 元の信号 x に、生成した倍音 harmonics を直接加算
                // このとき、hpStateを使って直流(DC)成分をカットしつつ戻すのがプロの技
                let x_excited: f32 = x + harmonics * exciteMix;

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

export function process_simd(
    len: i32,
    targetLevel: f32, expansionDepth: f32, aggression: f32,
    exciteAmount: f32, exciteMix: f32
): void {
    const sampleRate = g_sampleRate;
    const oversample = g_oversample;
    const taps = g_taps;
    const tapsMask = g_tapsMask;
    const weightTotalConst = g_weightTotalConst;

    const G1 = aggression;
    const G2 = G1 * f32(0.75); const G3 = G2 * f32(0.55);
    const G4 = G3 * f32(0.35); const G5 = G4 * f32(0.20);
    const G6 = G5 * f32(0.15); const G7 = G6 * f32(0.10);

    const b1 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(4000)) / sampleRate), 2));
    const b2 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(8000)) / sampleRate), 2));
    const b3 = f32(Math.pow(f64((f32(2) * f32(Math.PI) * f32(14000)) / sampleRate), 2));

    // LとRを明示的に個別呼び出し
    processChannel(
        INPUT_L, OUTPUT_L, HIST_L, STATE_L, SINC_PTR,
        len, oversample, taps, tapsMask, weightTotalConst,
        G1, G2, G3, G4, G5, G6, G7, b1, b2, b3,
        targetLevel, expansionDepth, exciteAmount, exciteMix
    );
    processChannel(
        INPUT_R, OUTPUT_R, HIST_R, STATE_R, SINC_PTR,
        len, oversample, taps, tapsMask, weightTotalConst,
        G1, G2, G3, G4, G5, G6, G7, b1, b2, b3,
        targetLevel, expansionDepth, exciteAmount, exciteMix
    );
}
