"use client";

import { useEffect } from "react";
import Image from "next/image";
import Script from "next/script";

export function GeneratedPage() {
  const highlightRoles = (text: string) =>
    text
      .replace(/The Client/g, "<span class='text-brand-400 font-semibold'>The Client</span>")
      .replace(/The Developer/g, "<span class='text-blue-400 font-semibold'>The Developer</span>");

  useEffect(() => {
    const canvas = document.getElementById("shader-canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      return;
    }

    const gl = canvas.getContext("webgl");
    if (!gl) {
      return;
    }

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    };

    window.addEventListener("resize", resize);
    resize();

    const compileShader = (context: WebGLRenderingContext, source: string, type: number) => {
      const shader = context.createShader(type);
      if (!shader) {
        throw new Error("Failed to create shader");
      }
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        throw new Error(context.getShaderInfoLog(shader) || "Shader compile failed");
      }
      return shader;
    };

    const vertSrc = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fragSrc = `
      precision highp float;

      uniform vec2 iResolution;
      uniform float iTime;

      vec3 hash(vec3 p) {
        p = vec3(
          dot(p, vec3(127.1, 311.7, 74.7)),
          dot(p, vec3(269.5, 183.3, 246.1)),
          dot(p, vec3(113.5, 271.9, 124.6))
        );
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
      }

      float noise(in vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(
            mix(
              dot(hash(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0)),
              dot(hash(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0)),
              u.x
            ),
            mix(
              dot(hash(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0)),
              dot(hash(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0)),
              u.x
            ),
            u.y
          ),
          mix(
            mix(
              dot(hash(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0)),
              dot(hash(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0)),
              u.x
            ),
            mix(
              dot(hash(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0)),
              dot(hash(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0)),
              u.x
            ),
            u.y
          ),
          u.z
        );
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / iResolution.xy;
        vec3 stars_direction = normalize(vec3(uv * 2.0 - 1.0, 1.0));
        float stars_threshold = 8.0;
        float stars_exposure = 200.0;
        float stars = pow(clamp(noise(stars_direction * 200.0), 0.0, 1.0), stars_threshold) * stars_exposure;
        stars *= mix(0.4, 1.4, noise(stars_direction * 100.0 + vec3(iTime)));
        gl_FragColor = vec4(vec3(stars), 1.0);
      }
    `;

    const vertShader = compileShader(gl, vertSrc, gl.VERTEX_SHADER);
    const fragShader = compileShader(gl, fragSrc, gl.FRAGMENT_SHADER);

    const program = gl.createProgram();
    if (!program) {
      throw new Error("Failed to create shader program");
    }
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
    }
    gl.useProgram(program);

    const posLoc = gl.getAttribLocation(program, "position");
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const iResolution = gl.getUniformLocation(program, "iResolution");
    const iTime = gl.getUniformLocation(program, "iTime");

    let rafId = 0;
    const render = (time: number) => {
      gl.uniform2f(iResolution, canvas.width, canvas.height);
      gl.uniform1f(iTime, time * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafId = window.requestAnimationFrame(render);
    };

    rafId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  useEffect(() => {
    const steps = Array.from(document.querySelectorAll(".step-item"));
    if (!steps.length) {
      return;
    }

    const updateActiveIndex = () => {
      const viewportCenter = window.innerHeight * 0.45;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      steps.forEach((step, index) => {
        const rect = step.getBoundingClientRect();
        const elementCenter = rect.top + rect.height / 2;
        const distance = Math.abs(elementCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });

      steps.forEach((step, index) => {
        if (index === closestIndex) {
          step.classList.add("is-active");
        } else {
          step.classList.remove("is-active");
        }
      });
    };

    let rafId = 0;
    const onScroll = () => {
      if (rafId) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        updateActiveIndex();
        rafId = 0;
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updateActiveIndex();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return (
    <div className="overflow-x-hidden selection:bg-brand-500 selection:text-white">
      <Script src="https://code.iconify.design/iconify-icon/1.0.7/iconify-icon.min.js" strategy="afterInteractive" />

      {/* Background (Aura shader) */}
      <div
        className="aura-background-component top-0 w-full -z-10 hue-rotate-15 saturate-200 h-screen fixed"
        style={{
          maskImage: "linear-gradient(to bottom, transparent, black 0%, black 39%, transparent)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black 0%, black 39%, transparent)",
        }}
        data-alpha-mask="39"
      >
        <canvas id="shader-canvas" className="absolute inset-0 -z-10" />
      </div>

      {/* Header */}
      <header className="fixed top-0 w-full z-50 glass-panel border-b-0 border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Logo */}
          <a href="#" className="group flex items-center gap-2">
            <Image
              src="/nebulonLogo.svg"
              alt="Nebulon"
              width={140}
              height={28}
              className="h-6 w-auto md:h-7 opacity-90 group-hover:opacity-100 transition-opacity duration-300"
              priority
            />
          </a>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-400">
            {[
              { label: "Home", href: "#" },
              { label: "How It Works", href: "#how-it-works" },
              { label: "Features", href: "#features" },
              { label: "Trust", href: "#trust" },
            ].map((item) => (
              <a key={item.label} href={item.href} className="hover:text-white transition-colors relative group">
                {item.label}
                <span className="absolute -bottom-1 left-0 w-0 h-px bg-brand-500 transition-all group-hover:w-full" />
              </a>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <a href="#" className="hidden md:block text-sm font-medium text-gray-400 hover:text-white transition-colors">
              Documentation
            </a>
            <a href="/login" className="bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold py-2 px-4 rounded-full transition-all flex items-center gap-2 shadow-[0_0_15px_rgba(110,86,207,0.4)]">
              <iconify-icon icon="solar:wallet-linear" width="16" />
              Connect Wallet
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="min-h-screen flex flex-col overflow-hidden pt-24 pb-12 relative items-center justify-center">
        {/* Background Effects */}
        <div className="absolute inset-0 grid-bg -z-10" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-brand-500/10 rounded-full blur-[100px] -z-10 pointer-events-none" />

        <div className="max-w-4xl mx-auto px-6 text-center z-10">
          {/* Headlines */}
          <div className="flex flex-col gap-0 md:gap-1 mb-6 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-semibold tracking-tighter text-white leading-[1.05]">
              Safe Escrow
            </h1>
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-semibold tracking-tighter text-brand-500 drop-shadow-[0_0_20px_rgba(110,86,207,0.5)] leading-[1.05]">
              Private Milestones
            </h1>
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-semibold tracking-tighter text-white leading-[1.05]">
              On <span className="text-gradient-solana">Solana</span>
            </h1>
          </div>

          {/* Powered By */}
          <div className="flex flex-col items-center justify-center gap-2 mb-5 opacity-70 animate-fade-in-up" style={{ animationDelay: "0.25s" }}>
            <span className="text-[10px] uppercase tracking-widest text-gray-500">powered by</span>
            <Image
              src="/MagicBlock-Logo-White.png"
              alt="MagicBlock"
              width={140}
              height={32}
              className="h-4 md:h-5 w-auto opacity-90"
              priority
            />
          </div>

          {/* Description */}
          <p className="max-w-xl mx-auto text-base md:text-lg text-gray-400 mb-8 leading-relaxed animate-fade-in-up" style={{ animationDelay: "0.4s" }}>
            <span className="inline-flex items-center gap-2 align-middle">
              <span>With</span>
              <Image
                src="/nebulonLogo.svg"
                alt="Nebulon"
                width={90}
                height={20}
                className="h-4 md:h-5 w-auto"
              />
            </span>
            , lock funds in a secure escrow, negotiate terms privately, and approve milestones with confidence. Payments are released only after work is accepted, backed by an on-chain dispute and refund system that guarantees funds move only when tasks are successfully completed.
          </p>

          {/* CTA Interaction */}
          <div className="flex flex-col items-center justify-center min-h-[64px] mb-10 animate-fade-in-up" style={{ animationDelay: "0.5s" }}>
            <input type="checkbox" id="role-switch" className="hidden peer" />

            <label htmlFor="role-switch" className="default-btn cursor-pointer bg-brand-500 hover:bg-brand-600 text-white text-sm md:text-base font-semibold py-2.5 px-6 rounded-full transition-all shadow-[0_0_20px_rgba(110,86,207,0.3)] hover:scale-105 active:scale-95 flex items-center gap-2">
              Create a Contract
              <iconify-icon icon="solar:arrow-right-linear" />
            </label>

            <a href="#" className="default-btn mt-3 text-xs md:text-sm text-gray-500 hover:text-white transition-colors border-b border-transparent hover:border-gray-500">
              View Documentation
            </a>

            <div className="role-options hidden flex-col md:flex-row gap-4 items-center">
              <button className="group bg-dark-700 hover:bg-brand-900 border border-white/10 hover:border-brand-500/50 p-6 rounded-xl transition-all w-64 text-left">
                <div className="bg-brand-500/20 w-10 h-10 rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform text-brand-500">
                  <iconify-icon icon="solar:briefcase-linear" width="24" />
                </div>
                <h3 className="text-white font-semibold mb-1">I'll hire a service!</h3>
                <p className="text-xs text-gray-500">Create client contract</p>
              </button>

              <button className="group bg-dark-700 hover:bg-brand-900 border border-white/10 hover:border-brand-500/50 p-6 rounded-xl transition-all w-64 text-left">
                <div className="bg-teal-500/20 w-10 h-10 rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform text-teal-400">
                  <iconify-icon icon="solar:code-linear" width="24" />
                </div>
                <h3 className="text-white font-semibold mb-1">I'll provide service!</h3>
                <p className="text-xs text-gray-500">Create dev contract</p>
              </button>

              <label htmlFor="role-switch" className="mt-4 md:mt-0 md:ml-2 text-gray-500 hover:text-white cursor-pointer p-2 rounded-full hover:bg-white/5 transition-colors">
                <iconify-icon icon="solar:close-circle-linear" width="24" />
              </label>
            </div>
          </div>

          {/* Feature Pills */}
          <div className="flex flex-wrap justify-center gap-2.5 animate-fade-in-up" style={{ animationDelay: "0.6s" }}>
            {[
              { icon: "solar:shield-linear", label: "Private Terms" },
              { icon: "solar:lock-password-linear", label: "Milestone Approvals" },
              { icon: "solar:check-circle-linear", label: "On-Chain Disputes" },
              { icon: "solar:eye-linear", label: "MagicBlock PER" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/5 text-[11px] font-medium text-gray-300">
                <iconify-icon icon={item.icon} className="text-brand-500" />
                {item.label}
              </div>
            ))}
          </div>
        </div>

        {/* Trust Guarantees */}
        <div className="w-full max-w-5xl mx-auto px-6 mt-16 md:mt-24 border-t border-white/5 pt-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
            <div className="flex flex-col gap-2 items-center">
              <span className="text-sm font-semibold text-white">Private by default</span>
              <p className="text-xs text-gray-500">Terms &amp; milestone details stored securely in MagicBlock PER.</p>
            </div>
            <div className="flex flex-col gap-2 items-center">
              <span className="text-sm font-semibold text-white">Trustless escrow</span>
              <p className="text-xs text-gray-500">Funds controlled by immutable program rules, not humans.</p>
            </div>
            <div className="flex flex-col gap-2 items-center">
              <span className="text-sm font-semibold text-white">Dispute + Refund paths</span>
              <p className="text-xs text-gray-500">On-chain judge, timeout refund, and mutual cancellation.</p>
            </div>
          </div>
        </div>
      </main>

      {/* How It Works Section */}
      <section className="border-y bg-dark-900/40 border-white/5 pt-24 pb-24 relative backdrop-blur-3xl" id="how-it-works">
        <div className="max-w-4xl mr-auto ml-auto pr-6 pl-6">
          <div className="text-center mb-24">
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-white mb-4">How It Works</h2>
            <p className="text-gray-400 text-lg">A simple, secure process that protects both clients and contractors.</p>
          </div>

          <div className="relative space-y-24 md:space-y-32">
            <div className="absolute left-4 md:left-1/2 md:-translate-x-1/2 top-0 bottom-0 w-[2px] bg-gradient-to-b from-transparent via-brand-500/40 to-transparent" />

            {[
              {
                number: "01",
                icon: "solar:file-text-linear",
                title: "Create",
                description: "Create an escrow contract between client and contractor.",
                clientHint: "The Client can create a contract, and invite The Developer to discuss it.",
                developerHint: "The Developer can create a contract and can invite The Client to discuss it.",
              },
              {
                number: "02",
                icon: "solar:list-check-linear",
                title: "Set Milestones",
                description: "Define the milestones that must be completed.",
                clientHint: "The Client can set the milestones of the contract that The Developer must complete first to receive the funds.",
                developerHint: "The Developer can check the milestones of the contract that The Client set and can also add them.",
              },
              {
                number: "03",
                icon: "solar:lock-password-linear",
                title: "Set Terms",
                description: "Negotiate contract terms and deadline privately.",
                clientHint: "The Client can propose and edit the total payment amount and contract deadline.",
                developerHint: "The Developer can review and discuss the payment amount and deadline proposed by The Client.",
              },
              {
                number: "04",
                icon: "solar:check-circle-linear",
                title: "Sign & Commit",
                description: "Terms and deadline are committed to L1.",
                clientHint: "The Client signs the agreed terms, locking the contract for funding.",
                developerHint: "The Developer signs the agreed terms, confirming the payment and deadline.",
              },
              {
                number: "05",
                icon: "solar:card-send-linear",
                title: "Fund",
                description: "Funds stay locked until completion.",
                clientHint: "The Client funds the escrow with the total payment amount.",
                developerHint: "The Developer waits for The Client to fund the escrow before starting work.",
              },
              {
                number: "06",
                icon: "solar:scale-linear",
                title: "Complete Milestones",
                description: "Contractor submits, client approves.",
                clientHint: "The Client reviews and approves each milestone as The Developer completes them.",
                developerHint: "The Developer submits milestones for The Client approval. No payout occurs until all are approved.",
              },
              {
                number: "07",
                icon: "solar:confetti-minimalistic-linear",
                title: "Payout!",
                description: "Contractor claims payout.",
                clientHint:
                  "The Client already paid at funding, but funds are only released after all tasks are completed and approved.\n\nIf The Developer misses the deadline, The Client can reclaim the funds.",
                developerHint: "After all milestones are approved, The Developer claims the final payout in one transfer.",
              },
            ].map((step, index) => (
              <div key={step.number} className="step-item group relative z-10 grid grid-cols-[auto_1fr] md:grid-cols-1 gap-6 md:gap-0 pl-0" data-index={index}>
                <div className="relative flex flex-col items-center justify-start md:w-full">
                  <div className="absolute -top-1 -right-1 md:right-1/2 md:-mr-8 md:-mt-2 w-5 h-5 md:w-7 md:h-7 rounded-full bg-brand-500/20 text-brand-500 text-[10px] md:text-xs font-bold font-mono flex items-center justify-center z-30 ring-4 ring-dark-900 transition-colors duration-500 group-[.is-active]:bg-brand-500 group-[.is-active]:text-white">
                    {step.number}
                  </div>
                  <div className="relative w-10 h-10 md:w-20 md:h-20 rounded-full border-2 flex items-center justify-center transition-all duration-500 ease-out bg-brand-500/5 border-brand-500/30 text-brand-500 group-[.is-active]:bg-brand-500 group-[.is-active]:border-brand-500 group-[.is-active]:text-white group-[.is-active]:shadow-[0_0_25px_rgba(110,86,207,0.6)] group-[.is-active]:scale-110">
                    <iconify-icon icon={step.icon} className="text-[26px] md:text-[40px] leading-none" />

                    {/* Desktop hints - attached to the icon circle */}
                    <div className="hidden md:block absolute right-full top-1/2 -translate-y-1/2 mr-24 w-72 p-5 rounded-xl border border-brand-500/20 bg-dark-900/90 backdrop-blur-xl shadow-xl transition-all duration-700 ease-out opacity-0 translate-x-8 scale-95 origin-right pointer-events-none group-[.is-active]:opacity-100 group-[.is-active]:translate-x-0 group-[.is-active]:scale-100">
                      {step.clientHint.split("\n\n").map((paragraph, paragraphIndex) => (
                        <p
                          key={paragraphIndex}
                          className={`text-sm text-gray-300 leading-relaxed ${paragraphIndex > 0 ? "mt-3" : ""}`}
                          dangerouslySetInnerHTML={{ __html: highlightRoles(paragraph) }}
                        />
                      ))}
                    </div>
                    <div className="hidden md:block absolute left-full top-1/2 -translate-y-1/2 ml-24 w-72 p-5 rounded-xl border border-brand-500/20 bg-dark-900/90 backdrop-blur-xl shadow-xl transition-all duration-700 ease-out opacity-0 -translate-x-8 scale-95 origin-left pointer-events-none group-[.is-active]:opacity-100 group-[.is-active]:translate-x-0 group-[.is-active]:scale-100">
                      <p
                        className="text-sm text-gray-300 leading-relaxed"
                        dangerouslySetInnerHTML={{
                          __html: highlightRoles(step.developerHint),
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-col md:items-center justify-center pt-1 md:pt-6">
                  <div className="md:text-center md:bg-dark-800/50 md:border md:border-white/5 md:backdrop-blur-sm md:rounded-lg md:px-6 md:py-3 md:min-w-[180px]">
                    <h3 className="text-lg md:text-xl font-semibold text-white mb-1">{step.title}</h3>
                    <p className="text-sm text-gray-400 md:hidden">{step.description}</p>
                  </div>

                  <div className="md:hidden mt-4 space-y-3 w-full max-w-sm transition-all duration-700 ease-out opacity-0 -translate-y-4 scale-95 max-h-0 overflow-hidden group-[.is-active]:max-h-[500px] group-[.is-active]:opacity-100 group-[.is-active]:translate-y-0 group-[.is-active]:scale-100 group-[.is-active]:pt-2">
                    <div className="p-4 rounded-xl border border-brand-500/20 bg-dark-800/80">
                      <p
                        className="text-xs text-gray-300 leading-relaxed"
                        dangerouslySetInnerHTML={{
                          __html: highlightRoles(step.clientHint.split("\n\n").join(" ")),
                        }}
                      />
                    </div>
                    <div className="p-4 rounded-xl border border-brand-500/20 bg-dark-800/80">
                      <p
                        className="text-xs text-gray-300 leading-relaxed"
                        dangerouslySetInnerHTML={{
                          __html: highlightRoles(step.developerHint),
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Safety Guarantees */}
      <section className="py-24 max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            {
              icon: "solar:shield-linear",
              title: "Client Safety",
              description:
                "Funds only move when milestones are approved. No partial payouts until all work is complete.",
            },
            {
              icon: "solar:lock-keyhole-linear",
              title: "Contractor Safety",
              description:
                "Funds are locked upfront in the escrow PDA. Payment is secured on-chain before work starts.",
            },
            {
              icon: "solar:eye-linear",
              title: "Privacy",
              description:
                "Terms and milestones are stored in MagicBlock PER. Only authorized parties can read them.",
            },
            {
              icon: "solar:scale-linear",
              title: "Dispute Resolution",
              description:
                "On-chain judge resolves disputes according to program rules before final approval.",
            },
            {
              icon: "solar:clock-circle-linear",
              title: "Timeout Protection",
              description: "Clients can claim refunds if deadlines expire. Mutual cancel option available.",
            },
            {
              icon: "solar:users-group-rounded-linear",
              title: "Non-Custodial",
              description:
                "Funds are held by the escrow program (PDA), not a company. No third-party risk.",
            },
          ].map((item) => (
            <div
              key={item.title}
              className="group p-8 rounded-2xl bg-dark-800 border border-white/5 hover:border-brand-500/30 transition-colors relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
                <iconify-icon icon={item.icon} width="100" className="text-brand-500" />
              </div>
              <div className="w-12 h-12 bg-brand-500/10 rounded-lg flex items-center justify-center mb-6 text-brand-500">
                <iconify-icon icon={item.icon} width="24" />
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">{item.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison Table */}
      <section id="features" className="py-24 bg-dark-800 border-y border-white/5">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl font-semibold text-white mb-12 text-center">Why Nebulon?</h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="py-4 px-6 text-gray-400 font-medium">Feature</th>
                  <th className="py-4 px-6 text-gray-500 font-medium text-center">No Escrow</th>
                  <th className="py-4 px-6 text-gray-500 font-medium text-center">Regular Escrow</th>
                  <th className="py-4 px-6 text-brand-400 font-bold bg-brand-500/5 border-t border-l border-r border-brand-500/20 rounded-t-xl w-1/4">
                    Nebulon
                  </th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {[
                  { name: "Private Terms & Milestones", nebulon: true, regularEscrow: false, noEscrow: false },
                  { name: "Milestone Approvals", nebulon: true, regularEscrow: "partial", noEscrow: false },
                  { name: "On-chain Judge", nebulon: true, regularEscrow: false, noEscrow: false },
                  { name: "Timeout Refund", nebulon: true, regularEscrow: "partial", noEscrow: false },
                  { name: "Mutual Cancel", nebulon: true, regularEscrow: "partial", noEscrow: false },
                  { name: "Dispute Resolution", nebulon: true, regularEscrow: false, noEscrow: false },
                  { name: "Easy to Use", nebulon: true, regularEscrow: true, noEscrow: true },
                  { name: "Works for Any Deal Size", nebulon: true, regularEscrow: true, noEscrow: true },
                ].map((feature, index, arr) => {
                  const renderStatus = (status: boolean | "partial") => {
                    if (status === true) {
                      return <iconify-icon icon="solar:check-circle-bold" width="20" />;
                    }
                    if (status === "partial") {
                      return <iconify-icon icon="solar:minus-circle-linear" width="20" />;
                    }
                    return <iconify-icon icon="solar:close-circle-linear" width="20" />;
                  };

                  const isLast = index === arr.length - 1;
                  return (
                    <tr key={feature.name} className={`hover:bg-white/5 transition-colors ${!isLast ? "border-b border-white/5" : ""}`}>
                      <td className="py-4 px-6">{feature.name}</td>
                    <td className="py-4 px-6 text-center text-gray-400">
                      <div className="flex justify-center">
                        {renderStatus(feature.noEscrow)}
                      </div>
                    </td>
                      <td className="py-4 px-6 text-center text-gray-600">
                        <div className="flex justify-center">
                          {renderStatus(feature.regularEscrow)}
                        </div>
                      </td>
                    <td className={`py-4 px-6 bg-brand-500/5 border-x border-brand-500/20 text-brand-400 ${isLast ? "border-b rounded-b-xl" : ""}`}>
                      <div className="flex justify-center">
                        {renderStatus(feature.nebulon)}
                      </div>
                    </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Privacy Bento Grid */}
      <section className="py-24 max-w-7xl mx-auto px-6">
        <h2 className="text-3xl font-semibold text-white mb-12 text-center">Privacy-First Features</h2>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2 md:row-span-2 p-8 bg-gradient-to-br from-brand-900/40 to-dark-800 border border-brand-500/20 rounded-3xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-12 opacity-5 group-hover:opacity-10 transition-opacity">
              <iconify-icon icon="solar:eye-linear" width="200" className="text-brand-500" />
            </div>
            <div className="h-full flex flex-col justify-between relative z-10">
              <div>
                <div className="w-12 h-12 bg-brand-500 rounded-xl flex items-center justify-center mb-6 text-white shadow-lg shadow-brand-500/30">
                  <iconify-icon icon="solar:eye-linear" width="24" />
                </div>
                <h3 className="text-2xl font-semibold text-white mb-4">Private Terms &amp; Milestones</h3>
                <p className="text-gray-400 leading-relaxed text-lg">
                  Deal terms and milestone details are stored privately in MagicBlock PER. Unlike standard smart
                  contracts, your business logic isn&apos;t broadcast to the entire world. Only authorized parties can
                  read or update them.
                </p>
              </div>
            </div>
          </div>

          {[
            {
              icon: "solar:bolt-linear",
              title: "Fast Settlement",
              description: "Solana's fast finality enables quick settlements once conditions are met.",
            },
            {
              icon: "solar:users-group-rounded-linear",
              title: "Non-Custodial",
              description: "Funds are held by the escrow program (PDA), not by a company.",
            },
            {
              icon: "solar:shield-check-linear",
              title: "Funds Locked",
              description: "Client funds are locked in the PDA before work starts.",
            },
            {
              icon: "solar:scale-linear",
              title: "On-Chain Judge",
              description: "Designated judge resolves disputes via program rules.",
            },
          ].map((item) => (
            <div key={item.title} className="p-6 bg-dark-800 border border-white/5 hover:border-brand-500/30 rounded-3xl transition-all">
              <iconify-icon icon={item.icon} className="text-brand-500 mb-4" width="28" />
              <h4 className="text-white font-medium mb-2">{item.title}</h4>
              <p className="text-xs text-gray-400">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features Section */}
      <section id="trust" className="py-24 bg-dark-800 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl font-semibold text-white mb-12 text-center">Built for Modern Workflows</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-xl border border-white/10 bg-dark-900/50 flex flex-col items-start">
              <div className="flex items-center gap-3 mb-4">
                <iconify-icon icon="solar:bolt-linear" className="text-white" width="24" />
                <h3 className="text-lg font-medium text-white">Instant Fund Release</h3>
              </div>
              <p className="text-sm text-gray-400">
                Funds transfer instantly once milestones are approved, with Solana finality delivering fast settlement.
              </p>
            </div>

            <div className="p-6 rounded-xl border border-white/10 bg-dark-900/50 flex flex-col items-start">
              <div className="flex items-center gap-3 mb-4">
                <iconify-icon icon="solar:code-linear" className="text-white" width="24" />
                <h3 className="text-lg font-medium text-white">Integrated CLI</h3>
              </div>
              <p className="text-sm text-gray-400">
                Operate serverlessly or automate workflows with a first-class CLI built for advanced users.
              </p>
            </div>

            <div className="p-6 rounded-xl border border-white/10 bg-dark-900/50 flex flex-col items-start">
              <div className="flex items-center gap-3 mb-4">
                <iconify-icon icon="solar:shield-check-linear" className="text-white" width="24" />
                <h3 className="text-lg font-medium text-white">Programmable Safeguards</h3>
              </div>
              <p className="text-sm text-gray-400">
                Built-in dispute, timeout, and refund flows ensure enforcement without manual intervention.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-32 relative overflow-hidden">
        <div className="absolute inset-0 grid-bg -z-10 opacity-50" />
        <div className="max-w-4xl mx-auto px-6 text-center">
          <span className="inline-block py-1 px-3 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-brand-300 mb-6">
            Ready to start?
          </span>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight text-white mb-6">Ready to make deals safer?</h2>
          <p className="text-lg text-gray-400 mb-10 max-w-2xl mx-auto">
            For freelancers, teams, and businesses who need private terms with on-chain enforcement.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a href="/login" className="bg-brand-500 hover:bg-brand-600 text-white font-semibold py-3 px-8 rounded-full transition-all shadow-[0_0_25px_rgba(110,86,207,0.4)] flex items-center gap-2 inline-flex">
              Launch App <iconify-icon icon="solar:rocket-linear" />
            </a>
            <button className="bg-transparent border border-white/20 hover:border-white text-white font-medium py-3 px-8 rounded-full transition-colors">
              Read Docs
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-dark-900 border-t border-white/5 pt-16 pb-8">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-16">
            <div className="col-span-2">
              <a href="#" className="text-2xl font-bold tracking-tight text-white mb-4 block">
                Nebulon
              </a>
              <p className="text-sm text-gray-500 mb-6 max-w-xs">
                The private escrow protocol for Web3 deals. Secure, private, and trustless.
              </p>
              <div className="flex gap-4">
                {[
                  { icon: "akar-icons:twitter-fill", label: "Twitter", href: "https://x.com/northbyt3" },
                  { icon: "akar-icons:github-fill", label: "GitHub", href: "https://github.com/northbyt3/nebulon" },
                ].map((item) => (
                  <a key={item.label} href={item.href} className="text-gray-500 hover:text-white transition-colors" target="_blank" rel="noreferrer">
                    <iconify-icon icon={item.icon} width="20" />
                  </a>
                ))}
              </div>
            </div>

            {[
              {
                title: "Product",
                items: ["How It Works", "Features"],
              },
              {
                title: "Resources",
                items: ["Documentation"],
              },
            ].map((section) => (
              <div key={section.title}>
                <h4 className="text-white font-medium mb-4">{section.title}</h4>
                <ul className="space-y-2 text-sm text-gray-500">
                  {section.items.map((item) => (
                    <li key={item}>
                      <a href="#" className="hover:text-brand-500 transition-colors">
                        {item}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="border-t border-white/5 pt-8 flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-gray-600">
            <p>(c) 2026 Nebulon. All rights reserved.</p>
            <a href="https://t.me/northbyt3" className="text-gray-500 hover:text-brand-300 transition-colors" target="_blank" rel="noreferrer">
              Built By: @northbyt3
            </a>
            <div className="flex items-center gap-2">
              <span>Built on Solana</span>
              <span className="w-1 h-1 rounded-full bg-gray-600" />
              <span>Powered by MagicBlock PER</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

