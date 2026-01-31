"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Lock, CheckCircle, Scale, Send, PartyPopper, ListChecks } from "lucide-react";
import ScrollReveal from "@/components/scroll-reveal";

// Helper function to highlight keywords in text
const highlightText = (text: string, highlightWords: string[]) => {
  // Sort by length (longest first) to match "the client" before "client"
  const sortedWords = highlightWords.sort((a, b) => b.length - a.length);
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  const regex = new RegExp(`\\b(${sortedWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join("|")})\\b`, "gi");
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    // Add highlighted match
    parts.push(
      <span key={match.index} className="text-accent font-semibold">
        {match[0]}
      </span>
    );
    lastIndex = regex.lastIndex;
  }
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
};

const steps = [
  {
    number: "01",
    icon: FileText,
    title: "Create",
    description: "Create an escrow contract between client and contractor on Solana.",
    clientHint: "The Client can create a contract, and invite The Developer to discuss it.",
    developerHint: "The Developer can create a contract and can invite The Client to discuss it.",
  },
  {
    number: "02",
    icon: ListChecks,
    title: "Set Milestones",
    description: "Define the milestones that must be completed for the contract.",
    clientHint: "The Client can set the milestones of the contract that The Developer must complete first to receive the funds.",
    developerHint: "The Developer can check the milestones of the contract that The Client set and can also add them.",
  },
  {
    number: "03",
    icon: Lock,
    title: "Set Terms",
    description: "Negotiate contract terms, payment amount, and deadline privately using MagicBlock PER.",
    clientHint: "The Client can propose and edit the total payment amount and contract deadline.",
    developerHint: "The Developer can review and discuss the payment amount and deadline proposed by The Client.",
  },
  {
    number: "04",
    icon: CheckCircle,
    title: "Sign & Commit",
    description: "Both parties sign terms, then agreed payment + deadline are committed to L1 for enforcement.",
    clientHint: "The Client signs the agreed terms, locking the contract for funding.",
    developerHint: "The Developer signs the agreed terms, confirming the payment and deadline.",
  },
  {
    number: "05",
    icon: Send,
    title: "Fund",
    description: "Client funds the escrow. Funds stay locked until completion.",
    clientHint: "The Client funds the escrow with the total payment amount.",
    developerHint: "The Developer waits for The Client to fund the escrow before starting work.",
  },
  {
    number: "06",
    icon: Scale,
    title: "Complete Milestones",
    description: "Contractor submits milestones. Client approves each milestone (no payout yet).",
    clientHint: "The Client reviews and approves each milestone as The Developer completes them.",
    developerHint: "The Developer submits milestones for The Client approval. No payout occurs until all are approved.",
  },
  {
    number: "07",
    icon: PartyPopper,
    title: "Payout!",
    description: "After all milestones are approved, contractor claims payout. Disputes and timeout refunds are supported.",
    clientHint: "The Client already paid at funding, but funds are only released after all tasks are completed and approved.\n\nIf The Developer misses the deadline, The Client can reclaim the funds.",
    developerHint: "After all milestones are approved, The Developer claims the final payout in one transfer.",
  },
];

export function HowItWorks() {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    let rafId = 0;

    const updateActiveIndex = () => {
      const viewportCenter = window.innerHeight * 0.45;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      itemRefs.current.forEach((ref, index) => {
        if (!ref) {
          return;
        }
        const rect = ref.getBoundingClientRect();
        const elementCenter = rect.top + rect.height / 2;
        const distance = Math.abs(elementCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });

      setActiveIndex(closestIndex);
    };

    const onScroll = () => {
      if (rafId) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        updateActiveIndex();
        rafId = 0;
      });
    };

    const onResize = () => {
      updateActiveIndex();
    };

    updateActiveIndex();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return (
    <section id="how-it-works" className="py-24 bg-secondary/30">
      <div className="container mx-auto px-4">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            How It Works
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            A simple, secure process that protects both clients and contractors.
          </p>
        </div>

        {/* Vertical Timeline */}
        <div className="max-w-3xl mx-auto">
          <div className="relative px-4">
            {/* Vertical timeline line centered through icons */}
            <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-[2px] bg-gradient-to-b from-transparent via-accent/40 to-transparent" />

            {/* Steps container */}
            <div className="space-y-10 md:space-y-12">
              {steps.map((step, index) => {
                const Icon = step.icon;
                const isActive = index === activeIndex;

                return (
                  <div
                    key={step.number}
                    ref={(ref) => {
                      itemRefs.current[index] = ref;
                    }}
                    data-index={index}
                    className="relative"
                  >
                    <div className="flex flex-col items-center text-center">
                      {/* Icon + number + description box */}
                      <div className="relative z-10">
                        <div className="absolute -top-2 -right-2 z-20">
                          <div
                            className={`w-7 h-7 md:w-8 md:h-8 rounded-full text-xs md:text-sm font-bold flex items-center justify-center shadow-md transition-all duration-500 ${
                              isActive
                                ? "bg-accent text-accent-foreground"
                                : "bg-accent/20 text-accent"
                            }`}
                          >
                            {step.number}
                          </div>
                        </div>

                        <div
                          className={`w-16 h-16 md:w-20 md:h-20 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${
                            isActive
                              ? "border-accent bg-accent shadow-[0_0_25px_rgba(140,100,250,0.6)]"
                              : "border-accent/50 bg-accent/10"
                          }`}
                        >
                          <Icon
                            className={`w-8 h-8 md:w-10 md:h-10 transition-colors duration-500 ${
                              isActive ? "text-background" : "text-accent"
                            }`}
                          />
                        </div>

                        {/* Client hint - positioned to the left */}
                        <div
                          className={`absolute right-full top-1/2 -translate-y-1/2 mr-8 w-72 md:w-80 transition-all duration-700 ease-out hidden md:block ${
                            isActive
                              ? "opacity-100 translate-x-0 scale-100"
                              : "opacity-0 translate-x-8 scale-95 pointer-events-none"
                          }`}
                        >
                          <div className="rounded-lg bg-card border border-border px-4 py-3 md:px-5 md:py-4 shadow-lg">
                            {isActive && step.clientHint && (
                              <div className="text-sm text-muted-foreground leading-relaxed">
                                {step.clientHint.split('\n\n').map((paragraph, idx) => (
                                  <p key={idx} className={idx > 0 ? 'mt-3' : ''}>
                                    {highlightText(paragraph, ["The Client", "The Developer", "Client", "the Client", "Developer", "the Developer", "client", "the client", "developer", "the developer"])}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Developer hint - positioned to the right */}
                        <div
                          className={`absolute left-full top-1/2 -translate-y-1/2 ml-8 w-72 md:w-80 transition-all duration-700 ease-out hidden md:block ${
                            isActive
                              ? "opacity-100 translate-x-0 scale-100"
                              : "opacity-0 -translate-x-8 scale-95 pointer-events-none"
                          }`}
                        >
                          <div className="rounded-lg bg-card border border-border px-4 py-3 md:px-5 md:py-4 shadow-lg">
                            {isActive && step.developerHint && (
                              <div className="text-sm text-muted-foreground leading-relaxed">
                                {highlightText(step.developerHint, ["The Developer", "The Client", "Developer", "the Developer", "Client", "the Client", "developer", "the developer", "client", "the client"])}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Title - stays centered */}
                      <div className="mt-4 inline-block rounded-lg bg-card border border-border px-4 py-3 md:px-5 md:py-4 transition-all duration-300">
                        <div className="text-base md:text-lg font-semibold text-foreground">
                          {step.title}
                        </div>
                      </div>

                      {/* Mobile: Hints below (still in flow) */}
                      <div
                        className={`mt-4 w-full max-w-sm space-y-3 transition-all duration-700 ease-out md:hidden ${
                          isActive
                            ? "opacity-100 translate-y-0 scale-100"
                            : "opacity-0 -translate-y-4 scale-95 pointer-events-none max-h-0"
                        }`}
                      >
                        {isActive && step.clientHint && (
                          <div className="rounded-lg bg-card border border-border px-4 py-3 shadow-lg">
                            <div className="text-sm text-muted-foreground leading-relaxed">
                              {step.clientHint.split('\n\n').map((paragraph, idx) => (
                                <p key={idx} className={idx > 0 ? 'mt-3' : ''}>
                                  {highlightText(paragraph, ["The Client", "The Developer", "Client", "the Client", "Developer", "the Developer", "client", "the client", "developer", "the developer"])}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                        {isActive && step.developerHint && (
                          <div className="rounded-lg bg-card border border-border px-4 py-3 shadow-lg">
                            <div className="text-sm text-muted-foreground leading-relaxed">
                              {highlightText(step.developerHint, ["The Developer", "The Client", "Developer", "the Developer", "Client", "the Client", "developer", "the developer", "client", "the client"])}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
