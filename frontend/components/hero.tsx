"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ArrowRight, Shield, Lock, CheckCircle, Eye, Scale, Briefcase, Code } from "lucide-react";

const features = [
  { icon: Shield, label: "Private Terms & Milestones" },
  { icon: Lock, label: "Milestone Approvals" },
  { icon: CheckCircle, label: "On-Chain Disputes" },
  { icon: Eye, label: "MagicBlock PER" },
  { icon: Scale, label: "Timeout Refunds" },
];

export function Hero() {
  const [showRoleSelection, setShowRoleSelection] = useState(false);
  const [visibleLines, setVisibleLines] = useState([false, false, false]);

  useEffect(() => {
    // Animate lines in sequentially
    const timers = [
      setTimeout(() => setVisibleLines([true, false, false]), 100),
      setTimeout(() => setVisibleLines([true, true, false]), 400),
      setTimeout(() => setVisibleLines([true, true, true]), 700),
    ];

    return () => timers.forEach(timer => clearTimeout(timer));
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center pt-12 md:pt-16 overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-secondary/20" />
      
      {/* Accent glow */}
      <div 
        className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full blur-[120px] opacity-20"
        style={{ background: "var(--accent)" }}
      />

      <div className="relative z-10 container mx-auto px-4 text-center">
        {/* Main heading - Vertical stacked with animations */}
        <div className="flex flex-col items-center gap-3 md:gap-4 mb-6">
          <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight">
            <div 
              className={`block transition-all duration-700 ease-out ${
                visibleLines[0] 
                  ? 'opacity-100 translate-y-0' 
                  : 'opacity-0 translate-y-8'
              }`}
            >
              <span className="text-foreground">Safe Escrow</span>
            </div>
            <div 
              className={`block transition-all duration-700 ease-out ${
                visibleLines[1] 
                  ? 'opacity-100 translate-y-0 scale-100' 
                  : 'opacity-0 translate-y-8 scale-95'
              }`}
            >
              <span className="text-accent relative inline-block">
                Private Milestones
                {visibleLines[1] && (
                  <span className="absolute -inset-3 bg-accent/30 blur-2xl -z-10 rounded-full animate-pulse" />
                )}
              </span>
            </div>
            <div 
              className={`block transition-all duration-700 ease-out ${
                visibleLines[2] 
                  ? 'opacity-100 translate-y-0' 
                  : 'opacity-0 translate-y-8'
              }`}
            >
              <span className="text-foreground">On </span>
              <span 
                className="bg-gradient-to-tr from-[#9945FF] via-[#00D9FF] to-[#14F195] bg-clip-text text-transparent"
                style={{
                  backgroundImage: 'linear-gradient(to top right, #9945FF, #00D9FF, #14F195)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}
              >
                Solana
              </span>
            </div>
          </h1>
        </div>
        
        {/* Powered by MagicBlock */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <span className="text-sm md:text-base text-muted-foreground">powered by:</span>
          <Image
            src="/MagicBlock-Logo-White.png"
            alt="MagicBlock"
            width={120}
            height={32}
            className="h-6 md:h-8 w-auto opacity-90 hover:opacity-100 transition-opacity"
          />
        </div>

        {/* Subheading */}
        <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto mb-6">
          Lock funds in a trustless escrow. Negotiate terms privately. Approve milestones safely. 
          Payment is processed only when the work is accepted — with disputes and refunds handled on-chain.
        </p>

        {/* CTAs - Fixed height container to prevent layout shift */}
        <div className="relative flex flex-col items-center gap-4 min-h-[160px] justify-center mb-4">
          {/* Initial buttons */}
          <div className={`absolute flex flex-col gap-3 justify-center items-center transition-all duration-300 ${
            showRoleSelection 
              ? 'opacity-0 -translate-y-4 pointer-events-none' 
              : 'opacity-100 translate-y-0 pointer-events-auto'
          }`}>
            <Button 
              size="lg" 
              className="bg-primary text-primary-foreground hover:bg-primary/90 group text-lg py-6 px-8"
              onClick={() => {
                setShowRoleSelection(true);
              }}
            >
              Create a Contract
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Button>
            <Button size="md" variant="outline" className="border-border hover:bg-secondary bg-transparent">
              View Documentation
            </Button>
          </div>

          {/* Role selection */}
          <div className={`absolute flex flex-col items-center gap-3 w-full max-w-md transition-all duration-300 ${
            showRoleSelection 
              ? 'opacity-100 translate-y-0 pointer-events-auto' 
              : 'opacity-0 translate-y-4 pointer-events-none'
          }`}>
            <h3 className="text-base md:text-lg font-semibold text-foreground mb-1">
              What's your role on this contract?
            </h3>
            <div className="flex flex-col sm:flex-row gap-3 w-full">
              <Button
                size="lg"
                variant="outline"
                className="flex-1 border-border hover:border-accent hover:bg-accent/10 bg-transparent group h-auto py-4 flex flex-col items-center gap-2 transition-all duration-300"
                onClick={() => {
                  // TODO: Handle client role selection
                  console.log("Client selected");
                }}
              >
                <Briefcase className="w-5 h-5 text-accent group-hover:scale-110 transition-transform" />
                <span className="text-sm font-semibold text-foreground group-hover:text-accent transition-colors">I'll hire a service!</span>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="flex-1 border-border hover:border-accent hover:bg-accent/10 bg-transparent group h-auto py-4 flex flex-col items-center gap-2 transition-all duration-300"
                onClick={() => {
                  // TODO: Handle developer role selection
                  console.log("Developer selected");
                }}
              >
                <Code className="w-5 h-5 text-accent group-hover:scale-110 transition-transform" />
                <span className="text-sm font-semibold text-foreground group-hover:text-accent transition-colors">I'll provide the service!</span>
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground -mt-1"
              onClick={() => {
                setShowRoleSelection(false);
              }}
            >
              Back
            </Button>
          </div>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-3 mb-8 mt-8">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.label}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-card border border-border"
              >
                <Icon className="w-4 h-4 text-accent" />
                <span className="text-sm text-foreground">{feature.label}</span>
              </div>
            );
          })}
        </div>

        {/* Trust guarantees */}
        <div className="mt-12 md:mt-16 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto">
          {[
            { title: "Private by default", description: "Terms & milestone details stored in PER" },
            { title: "Trustless escrow", description: "Funds controlled by program rules" },
            { title: "Dispute + refund paths", description: "Judge, timeout refund, mutual cancel" },
          ].map((item) => (
            <div key={item.title} className="text-center p-4 rounded-lg bg-card border border-border">
              <div className="text-base font-semibold text-foreground mb-1">{item.title}</div>
              <div className="text-sm text-muted-foreground">{item.description}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
