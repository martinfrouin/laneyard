#!/usr/bin/env ruby
# frozen_string_literal: true

# Laneyard's Fastfile scanner.
#
#   ruby scan.rb --fastlane-dir fastlane
#
# Deliberately ignorant. It reports the keyword arguments given directly to a
# call whose value is a literal string, with the byte ranges of the value and of
# the whole `key: value` pair, and has no idea what a credential is. Deciding
# which of those matters is `src/fastfile/adoption.ts`'s job, next to the one
# table that already describes each credential kind — a second copy of that
# table here would be free to disagree with it, in a language that cannot check
# it.
#
# Nested structures are deliberately not descended into. The literal inside
# `gym(export_options: { provisioningProfiles: { "id" => "./x" } })` has no
# keyword to report — its key is a bundle id — and attributing it to `gym` would
# be noise the caller cannot act on. This claim stays narrow on purpose: a
# confident answer that is wrong is worse than one that admits its edge.
#
# It never requires fastlane. `introspect.rb` must, to enumerate lanes; a
# syntax tree needs only Prism, and paying a fastlane boot for it would make
# this too slow to run during `laneyard setup`.
#
# The output contract is `introspect.rb`'s: { "ok": true, ... } or
# { "ok": false, "error": "..." }. An error is a valid response.

require "json"

REAL_STDOUT = $stdout.dup

# Writes the one JSON object this process produces, and stops.
#
# Serialisation is *not* done here, on purpose: `JSON.generate` raises on a
# string that is not valid UTF-8, and a Fastfile may well hold one
# (`supply(json_key: "./key\xFF.json")` is enough). Raising from inside the
# writer put the failure outside every guard in this file, so the caller got a
# Ruby trace on stderr and nothing at all on stdout — the one outcome the
# contract at the top promises never to happen. Callers generate under a guard
# and hand the finished string here.
def emit(json)
  REAL_STDOUT.puts json
  REAL_STDOUT.flush
  exit 0
end

def respond(payload)
  emit(JSON.generate(payload))
end

def fail_with(message)
  # Scrubbed, because an error message can quote the bytes that caused it:
  # `JSON::GeneratorError` names the offending literal. An error path that
  # raises while reporting an error leaves the caller with nothing.
  respond({ ok: false, error: message.to_s.dup.force_encoding("UTF-8").scrub("?") })
end

dir_index = ARGV.index("--fastlane-dir")
fastlane_dir = dir_index ? ARGV[dir_index + 1] : "fastlane"
fastfile_path = File.join(Dir.pwd, fastlane_dir, "Fastfile")

fail_with("Fastfile not found: #{fastfile_path}") unless File.exist?(fastfile_path)

# Insurance, not a fix for a known culprit: unlike `introspect.rb`, which faces
# a fastlane that really does print banners and deprecation notices, nothing
# here prints — Prism parses silently and the Fastfile is never executed. The
# redirection stands so that anything which *starts* printing later (a stray
# `puts`, a warning from some future require) lands on stderr instead of
# corrupting the one JSON object the real output carries.
$stdout = $stderr

begin
  require "prism"
rescue LoadError => e
  fail_with("prism is not available in this Ruby (#{e.message})")
end

# Every `key: "literal"` inside a call, wherever the call sits.
#
# Descends through everything: a call inside an `if`, inside a `def`, inside a
# `platform` block, is still a call this file makes. `calls_within` in
# introspect.rb resolves helper methods to attribute actions to a *lane*; there
# is no such need here, because a literal path is a problem wherever it is
# written and belongs to the file rather than to any one lane.
def literals_in(node, out = [])
  return out if node.nil?

  node.compact_child_nodes.each do |child|
    if child.is_a?(Prism::CallNode)
      # Both node types, because `supply(json_key: "…")` parses as a
      # KeywordHashNode and `supply({json_key: "…"})` as a HashNode. They are
      # the same argument written two ways, and looking for only the first
      # missed the braced form entirely — silently, since a scan that finds
      # nothing is indistinguishable from a file with nothing to find.
      hashes = (child.arguments&.arguments || []).select do |a|
        a.is_a?(Prism::KeywordHashNode) || a.is_a?(Prism::HashNode)
      end
      hashes.flat_map(&:elements).each do |el|
        next unless el.is_a?(Prism::AssocNode)
        next unless el.key.is_a?(Prism::SymbolNode)
        next unless el.value.is_a?(Prism::StringNode)
        # A heredoc's location covers its *marker* — `<<~P` is four bytes —
        # while its value lives on the lines below. Reporting that range would
        # have the caller splice `ENV.fetch("...")` over the marker and leave
        # the body stranded after the call: a Fastfile that no longer parses,
        # written silently into someone's repository. Dropping heredocs costs
        # nothing real, because a credential path is never written as one while
        # `changelog:` and `message:` routinely are. Only Ruby can tell a
        # heredoc from a quoted string, so the decision has to be made here.
        next if el.value.opening&.start_with?("<<")

        # `start_offset` and `length` are byte offsets, and must stay that way:
        # the caller splices them into a Buffer. Prism also offers
        # `start_character_offset`, and swapping one in would still pass any
        # test whose fixture is pure ASCII while putting one accent above the
        # literal enough to land a patch mid-string in a build file.
        out << {
          action: child.name.to_s,
          arg: el.key.unescaped,
          value: el.value.unescaped,
          value_start: el.value.location.start_offset,
          value_length: el.value.location.length,
          pair_start: el.location.start_offset,
          pair_length: el.location.length,
          line: el.location.start_line
        }
      end
    end
    literals_in(child, out)
  end
  out
end

begin
  source = File.read(fastfile_path)
  result = Prism.parse(source)
  # A plain `raise`, not `fail_with`, and deliberately so: `fail_with` ends in
  # `respond`'s `exit 0`, which raises SystemExit — a subclass of Exception, so
  # calling it from inside this very `begin` would be caught by the `rescue`
  # below and answered a second time, corrupting the output with two JSON
  # blobs. Raising here and answering from the `rescue` clause (which is not
  # itself guarded) is the same shape `introspect.rb` uses for this.
  raise "Fastfile could not be parsed" unless result.success?
  # Serialised here rather than at the `emit` below, so that a literal Prism
  # read fine but JSON cannot represent — anything that is not valid UTF-8 —
  # becomes an ordinary `{ "ok": false }` instead of a trace. Only the write
  # stays outside the guard, for the SystemExit reason above.
  payload = JSON.generate({ ok: true, literals: literals_in(result.value) })
rescue Exception => e # rubocop:disable Lint/RescueException
  fail_with("Could not read the Fastfile: #{e.message}")
end

emit(payload)
