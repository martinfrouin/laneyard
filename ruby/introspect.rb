#!/usr/bin/env ruby
# frozen_string_literal: true

# Sidecar d'introspection de Laneyard.
#
# Lancé dans le dossier d'un projet — idéalement via `bundle exec` — il est le seul
# composant qui connaît fastlane. Il n'écrit jamais rien : il lit et renvoie du JSON
# sur la sortie standard.
#
#   ruby introspect.rb lanes   --fastlane-dir fastlane
#   ruby introspect.rb actions --fastlane-dir fastlane
#   ruby introspect.rb parse   --fastlane-dir fastlane
#
# Le contrat de sortie est constant : { "ok": true, ... } ou { "ok": false, "error": "..." }.
# Une erreur est une réponse valide, jamais une trace sur stderr.

require "json"

# Voir plus bas : la vraie sortie standard est mise de côté dès le départ pour que
# rien d'autre que notre JSON ne puisse s'y glisser.
REAL_STDOUT = $stdout.dup

def respond(payload)
  REAL_STDOUT.puts JSON.generate(payload)
  REAL_STDOUT.flush
  exit 0
end

def fail_with(message)
  respond({ ok: false, error: message.to_s })
end

command = ARGV[0]
dir_index = ARGV.index("--fastlane-dir")
fastlane_dir = dir_index ? ARGV[dir_index + 1] : "fastlane"
fastfile_path = File.join(Dir.pwd, fastlane_dir, "Fastfile")

fail_with("Fastfile introuvable : #{fastfile_path}") unless File.exist?(fastfile_path)

# fastlane écrit volontiers sur la sortie standard — avertissements de plugin,
# messages de dépréciation, bandeau de mise à jour. Un seul de ces messages
# corromprait le JSON attendu par l'appelant. Tout part donc vers l'erreur standard,
# et seule `respond` écrit sur la vraie sortie.
$stdout = $stderr

begin
  require "fastlane"
rescue LoadError => e
  fail_with("fastlane n'est pas disponible dans cet environnement Ruby (#{e.message})")
end

def collect_lanes(fastfile_path)
  ff = Fastlane::FastFile.new(fastfile_path)
  lanes = []
  ff.runner.lanes.each do |platform, platform_lanes|
    platform_lanes.each do |name, lane|
      lanes << {
        name: name.to_s,
        platform: platform&.to_s,
        description: Array(lane.description).join(" ").strip,
        private: lane.is_private
      }
    end
  end
  lanes
end

case command
when "lanes"
  begin
    lanes = collect_lanes(fastfile_path)
  rescue Exception => e # rubocop:disable Lint/RescueException
    # Un Fastfile est du Ruby arbitraire : son chargement peut lever n'importe quoi,
    # y compris des erreurs de syntaxe qui ne descendent pas de StandardError.
    #
    # Attention : `respond` du cas de succès doit rester HORS de ce begin/rescue.
    # `respond` termine par `exit 0`, qui lève SystemExit — une sous-classe
    # d'Exception, donc interceptée par ce `rescue Exception` si l'appel est fait
    # à l'intérieur. Le symptôme est un second JSON (l'erreur « exit ») écrit à la
    # suite du premier, ce qui corrompt la sortie côté appelant.
    fail_with("Chargement du Fastfile impossible : #{e.message}")
  end
  respond({ ok: true, lanes: lanes })
else
  fail_with("Commande inconnue : #{command.inspect}")
end
