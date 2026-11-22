cask "memosim" do
  version "1.1.4"
  sha256 "0cbb8dd375b40cad062d2d864376c6f422f6ad00931f3441e178560bfe49750a"

  url "https://github.com/MemoSim/app/releases/download/v#{version}/MemoSim-#{version}-macOS.dmg"
  name "MemoSim"
  desc "Agent-based modeling studio with an AI assistant pane"
  homepage "https://github.com/MemoSim"

  depends_on macos: ">= :sonoma"

  app "MemoSim.app"

  zap trash: [
    "~/Library/Application Support/NetLogo Chat",
    "~/Library/Caches/org.netlogochat.desktop",
    "~/Library/Preferences/org.netlogochat.desktop.plist",
  ]
end
