import { useState, useEffect, useCallback, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import * as bip39 from "bip39";
import {
  Lock, Circle, Copy, CheckCircle2, XCircle, RotateCcw,
  Activity, TrendingUp, TrendingDown, Bell, BellOff, Plus, Trash2, Wifi, WifiOff,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

const queryClient = new QueryClient();

// ─── Web Audio chime ─────────────────────────────────────────────────────────
const playSuccessChime = () => {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const playTone = (freq: number, start: number, dur: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
    gain.gain.setValueAtTime(0, ctx.currentTime + start);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur);
  };
  playTone(523.25, 0, 0.3);
  playTone(659.25, 0.15, 0.4);
  playTone(783.99, 0.3, 0.6);
};

// ─── Core SeedXOR entropy functions ──────────────────────────────────────────
// All shares XOR together = original entropy:
//   Share_1 ⊕ Share_2 ⊕ … ⊕ Share_n = Original Entropy

function xorBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) result[i] = a[i] ^ b[i];
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Split entropy into numShares shares via XOR.
 * useRandom=true  → each call produces different shares (but XOR always = original)
 * useRandom=false → deterministic shares derived from original entropy (index-seeded)
 */
function splitEntropy(
  entropyHex: string,
  numShares: number,
  useRandom: boolean
): string[] {
  const original = hexToBytes(entropyHex);
  const len = original.length;

  const shares: Uint8Array[] = [];

  if (useRandom) {
    // Generate (n-1) cryptographically random shares
    let xorAcc = new Uint8Array(original);
    for (let i = 0; i < numShares - 1; i++) {
      const s = crypto.getRandomValues(new Uint8Array(len));
      shares.push(s);
      xorAcc = xorBuffers(xorAcc, s);
    }
    // Last share = original XOR all previous → ensures XOR of all = original
    shares.push(xorAcc);
  } else {
    // Deterministic: derive each share by rotating/XOR-ing the entropy with index
    // Share_i = entropy rotated by i bytes XOR 0xAA..AA pattern seeded by i
    let xorAcc = new Uint8Array(original);
    for (let i = 0; i < numShares - 1; i++) {
      const s = new Uint8Array(len);
      for (let j = 0; j < len; j++) {
        s[j] = original[(j + i + 1) % len] ^ ((i * 0x5a + j * 0xa5) & 0xff);
      }
      shares.push(s);
      xorAcc = xorBuffers(xorAcc, s);
    }
    shares.push(xorAcc);
  }

  return shares.map(bytesToHex);
}

/**
 * Combine all share entropies via XOR to recover the original entropy.
 * XOR is commutative and associative — order does not matter.
 * ALL shares must be provided.
 */
function combineEntropy(shareEntropyHexes: string[]): string {
  if (shareEntropyHexes.length === 0) throw new Error("No shares provided");
  let result = hexToBytes(shareEntropyHexes[0]);
  for (let i = 1; i < shareEntropyHexes.length; i++) {
    result = xorBuffers(result, hexToBytes(shareEntropyHexes[i]));
  }
  return bytesToHex(result);
}

// ─── Tab types ────────────────────────────────────────────────────────────────
type Tab = "生成" | "拆分" | "合并" | "验证" | "监控";

// ─── Generate tab ─────────────────────────────────────────────────────────────
function GenerateTab() {
  const { toast } = useToast();
  const [strength, setStrength] = useState<128 | 192 | 256>(128);
  const [mnemonic, setMnemonic] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [generatedCount, setGeneratedCount] = useState(0);

  const generateNew = useCallback(
    (str: 128 | 192 | 256) => {
      const phrase = bip39.generateMnemonic(str);
      setMnemonic(phrase.split(" "));
      setGeneratedCount((prev) => prev + 1);
    },
    []
  );

  useEffect(() => {
    if (mnemonic.length === 0) generateNew(strength);
  }, [generateNew, strength, mnemonic.length]);

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => generateNew(strength), 1200);
    // Page Visibility API: immediately resume with a fresh mnemonic on return
    const onVisibility = () => {
      if (document.visibilityState === "visible") generateNew(strength);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isRunning, strength, generateNew]);

  const handleStrengthChange = (s: 128 | 192 | 256) => {
    setStrength(s);
    generateNew(s);
  };

  const handleSignConfirm = () => {
    playSuccessChime();
    toast({ title: "Signature authorized successfully", duration: 3000 });
  };

  const strengthOptions = [
    { label: "12词 (128 bit)", value: 128 as const },
    { label: "18词 (192 bit)", value: 192 as const },
    { label: "24词 (256 bit)", value: 256 as const },
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-8 w-full">
      {/* Controls */}
      <div className="w-full lg:w-72 shrink-0 flex flex-col gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="p-6 flex flex-col gap-6">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">
                Word Count
              </label>
              <div className="flex flex-col gap-2">
                {strengthOptions.map((opt) => (
                  <button
                    key={opt.value}
                    data-testid={`btn-strength-${opt.value}`}
                    onClick={() => handleStrengthChange(opt.value)}
                    className={`px-4 py-2.5 rounded text-sm text-left transition-all border ${
                      strength === opt.value
                        ? "bg-primary/10 border-primary/50 text-primary"
                        : "bg-background border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t border-border/50 flex flex-col gap-3">
              <Button
                data-testid="btn-generate"
                onClick={() => setIsRunning((r) => !r)}
                className={`w-full h-12 text-base font-bold ${
                  isRunning
                    ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                    : "bg-primary hover:bg-primary/90 text-primary-foreground"
                }`}
              >
                {isRunning ? "停止" : "生成新助记词"}
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    data-testid="btn-authorize"
                    className="w-full border-border/60 hover:bg-accent"
                  >
                    签名授权
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-border font-mono">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Signature Authorization</AlertDialogTitle>
                    <AlertDialogDescription className="text-muted-foreground">
                      Do you authorize this signature? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="border-border">No</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleSignConfirm}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      Yes
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between px-1">
          <div className="text-sm">
            {isRunning ? (
              <span className="flex items-center gap-1.5 text-primary font-medium" data-testid="status-live">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
                LIVE
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground" data-testid="status-idle">
                <Circle className="w-2 h-2 fill-muted-foreground" /> IDLE
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground" data-testid="text-counter">
            已生成:{" "}
            <span className="text-foreground font-medium">{generatedCount.toLocaleString()}</span> 组
          </div>
        </div>
      </div>

      {/* Word grid */}
      <div className="flex-1">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="mnemonic-grid">
          <AnimatePresence mode="popLayout">
            {mnemonic.map((word, i) => (
              <motion.div
                key={`${generatedCount}-${i}`}
                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.18, delay: i * 0.012 }}
              >
                <Card className="bg-card/40 border-border/40 hover:bg-card/60 hover:border-primary/30 transition-colors">
                  <CardContent className="p-3 flex items-center gap-3">
                    <span className="text-xs text-muted-foreground/50 w-5 text-right select-none">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="text-sm text-foreground font-medium" data-testid={`word-${i}`}>
                      {word}
                    </span>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {mnemonic.length > 0 && (
          <div className="mt-4 p-3 rounded border border-border/30 bg-card/20 text-xs text-muted-foreground">
            <span className="text-primary/70 font-semibold">Entropy:</span>{" "}
            <span className="font-mono break-all">
              {bip39.mnemonicToEntropy(mnemonic.join(" "))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Split tab ────────────────────────────────────────────────────────────────
// split() decodes mnemonic → entropy → generates N shares via XOR
// Share_1 ⊕ Share_2 ⊕ … ⊕ Share_n = Original Entropy
function SplitTab() {
  const { toast } = useToast();
  const [inputMnemonic, setInputMnemonic] = useState("");
  const [numShares, setNumShares] = useState(2);
  const [useRandom, setUseRandom] = useState(true);
  const [shares, setShares] = useState<{ entropy: string; mnemonic: string }[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<number | null>(null);

  const doSplit = () => {
    setError("");
    setShares([]);
    const words = inputMnemonic.trim().toLowerCase().split(/\s+/);
    const wordCount = words.length;
    if (![12, 18, 24].includes(wordCount)) {
      setError(`Invalid word count: ${wordCount}. Must be 12, 18, or 24.`);
      return;
    }
    if (!bip39.validateMnemonic(words.join(" "))) {
      setError("Invalid mnemonic — checksum verification failed.");
      return;
    }
    try {
      const originalEntropy = bip39.mnemonicToEntropy(words.join(" "));
      const shareEntropies = splitEntropy(originalEntropy, numShares, useRandom);
      const result = shareEntropies.map((hex) => ({
        entropy: hex,
        mnemonic: bip39.entropyToMnemonic(hex),
      }));
      setShares(result);
    } catch (e: any) {
      setError(e.message || "Split failed.");
    }
  };

  const copyShare = async (text: string, idx: number) => {
    await navigator.clipboard.writeText(text);
    setCopied(idx);
    setTimeout(() => setCopied(null), 1500);
    toast({ title: `Share ${idx + 1} copied`, duration: 2000 });
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          将助记词解码为原始 Entropy，然后通过按位 XOR 生成 N 个 Share。
          所有 Share 的 Entropy 按位异或后严格等于原始 Entropy：
          <span className="block mt-1 text-primary/80 font-mono">
            Share₁ ⊕ Share₂ ⊕ … ⊕ Shareₙ = Original Entropy
          </span>
        </p>
      </div>

      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-6 flex flex-col gap-5">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-widest">
              Input Mnemonic (12 / 18 / 24 words)
            </label>
            <Textarea
              data-testid="input-split-mnemonic"
              value={inputMnemonic}
              onChange={(e) => setInputMnemonic(e.target.value)}
              placeholder="Enter your BIP39 mnemonic phrase..."
              className="font-mono text-sm min-h-[80px] bg-background border-border/60 resize-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground uppercase tracking-widest">
                Number of Shares
              </label>
              <div className="flex gap-2">
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    data-testid={`btn-shares-${n}`}
                    onClick={() => setNumShares(n)}
                    className={`w-10 h-10 rounded text-sm font-mono border transition-all ${
                      numShares === n
                        ? "bg-primary/10 border-primary/50 text-primary"
                        : "bg-background border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted-foreground uppercase tracking-widest">
                Mode
              </label>
              <div className="flex gap-2">
                <button
                  data-testid="btn-mode-random"
                  onClick={() => setUseRandom(true)}
                  className={`px-3 py-2 rounded text-xs border transition-all ${
                    useRandom
                      ? "bg-primary/10 border-primary/50 text-primary"
                      : "bg-background border-border text-muted-foreground hover:border-primary/30"
                  }`}
                >
                  Random
                </button>
                <button
                  data-testid="btn-mode-deterministic"
                  onClick={() => setUseRandom(false)}
                  className={`px-3 py-2 rounded text-xs border transition-all ${
                    !useRandom
                      ? "bg-primary/10 border-primary/50 text-primary"
                      : "bg-background border-border text-muted-foreground hover:border-primary/30"
                  }`}
                >
                  Deterministic
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm p-3 rounded border border-destructive/30 bg-destructive/5">
              <XCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <Button
            data-testid="btn-do-split"
            onClick={doSplit}
            className="bg-primary text-primary-foreground hover:bg-primary/90 w-fit"
          >
            Execute Split
          </Button>
        </CardContent>
      </Card>

      {shares.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            Generated Shares — must collect ALL {shares.length} to recover original
          </p>
          <AnimatePresence>
            {shares.map((share, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.08 }}
              >
                <Card className="bg-card/40 border-border/40">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-primary uppercase tracking-widest">
                        Share {idx + 1}
                      </span>
                      <button
                        data-testid={`btn-copy-share-${idx}`}
                        onClick={() => copyShare(share.mnemonic, idx)}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {copied === idx ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copied === idx ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="font-mono text-sm text-foreground leading-relaxed break-all">
                      {share.mnemonic}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground/60 break-all">
                      entropy: {share.entropy}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ─── Combine tab ──────────────────────────────────────────────────────────────
// combine() XORs all share entropies → recovers original entropy → BIP39 encode
// XOR is commutative & associative — share order does not matter
// ALL shares must be provided
function CombineTab() {
  const { toast } = useToast();
  const [shareInputs, setShareInputs] = useState(["", ""]);
  const [result, setResult] = useState<{ entropy: string; mnemonic: string } | null>(null);
  const [error, setError] = useState("");
  const [copiedResult, setCopiedResult] = useState(false);

  const updateShare = (idx: number, value: string) => {
    setShareInputs((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
    setResult(null);
    setError("");
  };

  const addShare = () => setShareInputs((prev) => [...prev, ""]);
  const removeShare = (idx: number) =>
    setShareInputs((prev) => prev.filter((_, i) => i !== idx));

  const doCombine = () => {
    setError("");
    setResult(null);
    const filled = shareInputs.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (filled.length < 2) {
      setError("At least 2 shares are required.");
      return;
    }

    const entropies: string[] = [];
    for (let i = 0; i < filled.length; i++) {
      const words = filled[i].split(/\s+/);
      if (![12, 18, 24].includes(words.length)) {
        setError(`Share ${i + 1}: invalid word count (${words.length}). Must be 12, 18, or 24.`);
        return;
      }
      if (!bip39.validateMnemonic(words.join(" "))) {
        setError(`Share ${i + 1}: invalid mnemonic — checksum failed.`);
        return;
      }
      entropies.push(bip39.mnemonicToEntropy(words.join(" ")));
    }

    // Verify all entropies are the same byte length
    const lengths = entropies.map((e) => e.length);
    if (new Set(lengths).size > 1) {
      setError("All shares must have the same word count (same entropy size).");
      return;
    }

    try {
      const recoveredEntropy = combineEntropy(entropies);
      const recoveredMnemonic = bip39.entropyToMnemonic(recoveredEntropy);
      setResult({ entropy: recoveredEntropy, mnemonic: recoveredMnemonic });
      toast({ title: "Original mnemonic recovered", duration: 3000 });
    } catch (e: any) {
      setError(e.message || "Combine failed.");
    }
  };

  const copyResult = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.mnemonic);
    setCopiedResult(true);
    setTimeout(() => setCopiedResult(false), 1500);
    toast({ title: "Recovered mnemonic copied", duration: 2000 });
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground leading-relaxed">
          将全部 Share 的 Entropy 重新执行按位 XOR，恢复原始 Entropy 并重新生成原始助记词。
          <span className="block mt-1 text-primary/80 font-mono">
            Share₁ ⊕ Share₂ ⊕ … ⊕ Shareₙ = Original Entropy
          </span>
          XOR 满足交换律和结合律，Share 顺序不影响结果，但必须提供全部份额。
        </p>
      </div>

      <div className="space-y-3">
        {shareInputs.map((value, idx) => (
          <Card key={idx} className="bg-card/50 border-border/50">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-primary font-semibold uppercase tracking-widest">
                  Share {idx + 1}
                </label>
                {shareInputs.length > 2 && (
                  <button
                    data-testid={`btn-remove-share-${idx}`}
                    onClick={() => removeShare(idx)}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
              <Textarea
                data-testid={`input-share-${idx}`}
                value={value}
                onChange={(e) => updateShare(idx, e.target.value)}
                placeholder={`Enter share ${idx + 1} mnemonic...`}
                className="font-mono text-sm min-h-[70px] bg-background border-border/60 resize-none"
              />
            </CardContent>
          </Card>
        ))}

        <div className="flex gap-3">
          <Button
            variant="outline"
            data-testid="btn-add-share"
            onClick={addShare}
            className="border-border/60 text-muted-foreground hover:text-foreground text-sm"
          >
            + Add Share
          </Button>
          <Button
            data-testid="btn-do-combine"
            onClick={doCombine}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Recover Original
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive text-sm p-3 rounded border border-destructive/30 bg-destructive/5">
          <XCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="bg-primary/5 border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-primary flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                Recovered Original Mnemonic
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <p className="font-mono text-sm text-foreground leading-relaxed" data-testid="text-recovered-mnemonic">
                  {result.mnemonic}
                </p>
                <button
                  data-testid="btn-copy-result"
                  onClick={copyResult}
                  className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors mt-0.5"
                >
                  {copiedResult ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground/60 break-all">
                entropy: {result.entropy}
              </p>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

// ─── Verify tab ───────────────────────────────────────────────────────────────
function VerifyTab() {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "valid" | "invalid">("idle");
  const [info, setInfo] = useState<{ words: number; entropy: string } | null>(null);

  const doVerify = () => {
    const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const phrase = words.join(" ");
    const valid = bip39.validateMnemonic(phrase);
    setStatus(valid ? "valid" : "invalid");
    if (valid) {
      setInfo({ words: words.length, entropy: bip39.mnemonicToEntropy(phrase) });
    } else {
      setInfo(null);
    }
  };

  const reset = () => {
    setInput("");
    setStatus("idle");
    setInfo(null);
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <p className="text-xs text-muted-foreground">
        验证 BIP39 助记词的有效性（单词表校验 + 校验和验证）。
      </p>

      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-6 space-y-4">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-widest">
              Mnemonic Phrase
            </label>
            <Textarea
              data-testid="input-verify-mnemonic"
              value={input}
              onChange={(e) => { setInput(e.target.value); setStatus("idle"); setInfo(null); }}
              placeholder="Enter mnemonic to verify..."
              className="font-mono text-sm min-h-[80px] bg-background border-border/60 resize-none"
            />
          </div>
          <div className="flex gap-3">
            <Button
              data-testid="btn-verify"
              onClick={doVerify}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Verify
            </Button>
            <Button
              variant="ghost"
              data-testid="btn-reset-verify"
              onClick={reset}
              className="text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>

          {status !== "idle" && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex items-start gap-3 p-3 rounded border ${
                status === "valid"
                  ? "border-primary/30 bg-primary/5 text-primary"
                  : "border-destructive/30 bg-destructive/5 text-destructive"
              }`}
            >
              {status === "valid" ? (
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
              )}
              <div className="space-y-1 text-sm">
                <p className="font-semibold">
                  {status === "valid" ? "Valid BIP39 Mnemonic" : "Invalid Mnemonic"}
                </p>
                {info && (
                  <>
                    <p className="text-xs opacity-80">Words: {info.words}</p>
                    <p className="font-mono text-[10px] opacity-60 break-all">
                      entropy: {info.entropy}
                    </p>
                  </>
                )}
                {status === "invalid" && (
                  <p className="text-xs opacity-80">
                    Checksum verification failed or unknown words detected.
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card/30 border-border/30">
        <CardContent className="p-4 space-y-2 text-xs text-muted-foreground leading-relaxed">
          <p className="font-semibold text-foreground/70 uppercase tracking-widest">SeedXOR Principle</p>
          <p>
            SeedXOR 对助记词对应的底层 Entropy 执行按位 XOR 运算。
            12词 = 128bit，18词 = 192bit，24词 = 256bit。
          </p>
          <p className="font-mono text-primary/70 mt-1">
            Share₁ ⊕ Share₂ ⊕ … ⊕ Shareₙ = Original Entropy
          </p>
          <p>
            XOR 满足交换律和结合律，Share 顺序不影响恢复结果，
            但必须收集全部份额才能完整恢复原始 Entropy。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Root App ────────────────────────────────────────────────────────────────
const TABS: Tab[] = ["生成", "拆分", "合并", "验证"];

function SeedXORApp() {
  const [activeTab, setActiveTab] = useState<Tab>("生成");

  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground flex flex-col font-mono selection:bg-primary/30">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/30 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center border border-primary/20">
              <Lock className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h1 className="font-bold text-lg leading-tight tracking-tight">SeedXOR</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                BIP39 Entropy XOR Tool
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab}
                data-testid={`tab-${tab}`}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-2 text-sm rounded-md transition-colors whitespace-nowrap ${
                  activeTab === tab
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                {tab}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            {activeTab === "生成" && <GenerateTab />}
            {activeTab === "拆分" && <SplitTab />}
            {activeTab === "合并" && <CombineTab />}
            {activeTab === "验证" && <VerifyTab />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/30 py-4 px-6">
        <p className="text-center text-[10px] text-muted-foreground/50 max-w-2xl mx-auto">
          所有操作在浏览器本地执行，助记词及密钥不会离开设备。
          数字原理：Share₁ ⊕ Share₂ ⊕ … ⊕ Shareₙ = Original Entropy，
          经 BIP39 编码后复原原始助记词。
        </p>
      </footer>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SeedXORApp />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
