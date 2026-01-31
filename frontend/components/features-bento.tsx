"use client";

import { Eye, Shield, CheckCircle, Lock, Scale, Clock, Zap, FileText } from "lucide-react";

// Organized to fit perfectly in 2 rows of 4 columns (8 cards: 1 large + 6 small)
const features = [
  // Row 1: Large privacy card + 2 small cards
  {
    icon: Eye,
    title: "Private Terms & Milestones",
    description:
      "Deal terms and milestone details are stored privately in MagicBlock PER. Only authorized parties can read or update them.",
    size: "large",
    order: 1,
  },
  {
    icon: Zap,
    title: "Fast Settlement",
    description:
      "Solana's fast finality enables quick settlements once conditions are met.",
    size: "small",
    order: 2,
  },
  {
    icon: Lock,
    title: "Non-Custodial",
    description:
      "Funds are held by the escrow program account (PDA), not by a company.",
    size: "small",
    order: 3,
  },
  // Row 2: 4 small cards
  {
    icon: Shield,
    title: "Funds Locked Upfront",
    description:
      "Client funds are locked in the escrow program account (PDA) before work starts.",
    size: "small",
    order: 4,
  },
  {
    icon: CheckCircle,
    title: "Milestone Approvals",
    description:
      "Contractor submits milestones, client approves each one. No partial payout until completion.",
    size: "small",
    order: 5,
  },
  {
    icon: Scale,
    title: "On-Chain Dispute Resolution",
    description:
      "A designated on-chain judge resolves disputes according to program rules.",
    size: "small",
    order: 6,
  },
  {
    icon: Clock,
    title: "Timeout Refund & Mutual Cancel",
    description:
      "If deadlines expire, funds can be automatically refunded. Both parties can also cancel by agreement, unlocking funds without a dispute.",
    size: "small",
    order: 7,
  },
];

export function FeaturesBento() {
  return (
    <section className="py-24">
      <div className="container mx-auto px-4">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Privacy-First Features
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Everything you need for secure, private deals on Solana.
          </p>
        </div>

        {/* Bento grid - organized to fit perfectly in square layout */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {features
            .sort((a, b) => a.order - b.order)
            .map((feature) => {
              const Icon = feature.icon;
              const isLarge = feature.size === "large";
              
              return (
                <div
                  key={feature.title}
                  className={`group p-6 md:p-8 rounded-2xl bg-card border border-border hover:border-accent/50 transition-all flex flex-col ${
                    isLarge ? "lg:col-span-2" : "lg:col-span-1"
                  }`}
                >
                  <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4 group-hover:bg-accent/10 transition-colors">
                    <Icon className="w-6 h-6 text-accent" />
                  </div>
                  <h3 className={`font-semibold text-foreground mb-3 ${
                    isLarge ? "text-xl md:text-2xl" : "text-lg"
                  }`}>
                    {feature.title}
                  </h3>
                  <p className={`text-muted-foreground leading-relaxed flex-grow ${
                    isLarge ? "text-sm md:text-base" : "text-sm"
                  }`}>
                    {feature.description}
                  </p>
                </div>
              );
            })}
        </div>
      </div>
    </section>
  );
}
