"use client";

import { Github, FileCheck, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const trustItems = [
  {
    icon: Github,
    title: "Open Source",
    description: "All smart contract code is publicly available on GitHub for anyone to review and verify.",
    action: "View on GitHub",
    href: "#",
  },
  {
    icon: FileCheck,
    title: "Security Audit",
    description: "Comprehensive security audit in progress by leading blockchain security firm. Results coming Q2 2026.",
    status: "In Progress",
  },
  {
    icon: AlertTriangle,
    title: "Known Limitations",
    description: "Currently Solana-only. Multi-chain support planned for Q3 2026. Maximum escrow size: 1000 SOL.",
    status: "Disclosed",
  },
];

export function TrustSection() {
  return (
    <section id="trust" className="py-24 bg-secondary/30">
      <div className="container mx-auto px-4">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Built on Transparency
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            We believe trust is earned through openness. Here&apos;s everything you need to know about our security.
          </p>
        </div>

        {/* Trust cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {trustItems.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.title}
                className="p-6 rounded-2xl bg-card border border-border"
              >
                <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4">
                  <Icon className="w-6 h-6 text-accent" />
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-lg font-semibold text-foreground">{item.title}</h3>
                  {item.status && (
                    <span className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs font-medium">
                      {item.status}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  {item.description}
                </p>
                {item.action && (
                  <Button variant="ghost" size="sm" className="text-accent hover:text-accent/80 -ml-2">
                    {item.action}
                    <ExternalLink className="w-4 h-4 ml-1" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
