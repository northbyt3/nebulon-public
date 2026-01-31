"use client";

import { Check, X, Minus } from "lucide-react";

const features = [
  { name: "Private terms & milestones", nebulon: true, traditional: false, multisig: false, publicEscrow: false },
  { name: "Milestone approvals (no partial payout until final)", nebulon: true, traditional: true, multisig: false, publicEscrow: true },
  { name: "On-chain judge dispute", nebulon: true, traditional: false, multisig: false, publicEscrow: "partial" },
  { name: "Timeout refund", nebulon: true, traditional: false, multisig: false, publicEscrow: false },
  { name: "Mutual cancel", nebulon: true, traditional: false, multisig: false, publicEscrow: false },
  { name: "No Trust Required", nebulon: true, traditional: false, multisig: true, publicEscrow: true },
  { name: "Fast Settlement (Solana)", nebulon: true, traditional: false, multisig: true, publicEscrow: true },
  { name: "Transparent Fees", nebulon: true, traditional: false, multisig: true, publicEscrow: "partial" },
  { name: "Dispute Resolution", nebulon: true, traditional: true, multisig: false, publicEscrow: "partial" },
  { name: "Works for Any Deal Size", nebulon: true, traditional: false, multisig: true, publicEscrow: true },
];

function FeatureStatus({ status }: { status: boolean | string }) {
  if (status === true) {
    return <Check className="w-5 h-5 text-accent" />;
  }
  if (status === false) {
    return <X className="w-5 h-5 text-muted-foreground/50" />;
  }
  return <Minus className="w-5 h-5 text-muted-foreground" />;
}

export function Comparison() {
  return (
    <section id="features" className="py-24">
      <div className="container mx-auto px-4">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Why Nebulon?
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            See how Nebulon compares to traditional escrow services and other Web3 solutions.
          </p>
        </div>

        {/* Comparison table */}
        <div className="max-w-5xl mx-auto overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-4 px-4 font-medium text-muted-foreground">Feature</th>
                <th className="text-center py-4 px-4 font-semibold text-accent">Nebulon</th>
                <th className="text-center py-4 px-4 font-medium text-muted-foreground">Traditional Escrow</th>
                <th className="text-center py-4 px-4 font-medium text-muted-foreground">Multisig Wallet</th>
                <th className="text-center py-4 px-4 font-medium text-muted-foreground">Public On-chain Escrow</th>
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr key={feature.name} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                  <td className="py-4 px-4 text-sm text-foreground">{feature.name}</td>
                  <td className="py-4 px-4">
                    <div className="flex justify-center">
                      <FeatureStatus status={feature.nebulon} />
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex justify-center">
                      <FeatureStatus status={feature.traditional} />
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex justify-center">
                      <FeatureStatus status={feature.multisig} />
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex justify-center">
                      <FeatureStatus status={feature.publicEscrow} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
