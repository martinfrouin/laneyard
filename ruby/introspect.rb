#!/usr/bin/env ruby
# frozen_string_literal: true

# Laneyard's introspection sidecar.
#
# Launched in a project's folder — ideally via `bundle exec` — it's the only
# component that knows fastlane. It never writes anything: it reads and returns
# JSON on standard output.
#
#   ruby introspect.rb lanes   --fastlane-dir fastlane
#   ruby introspect.rb actions --fastlane-dir fastlane
#   ruby introspect.rb parse   --fastlane-dir fastlane
#
# The output contract is constant: { "ok": true, ... } or { "ok": false, "error": "..." }.
# An error is a valid response, never a trace on stderr.

require "json"

# See below: the real standard output is set aside right from the start so
# that nothing but our JSON can slip into it.
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

fail_with("Fastfile not found: #{fastfile_path}") unless File.exist?(fastfile_path)

# fastlane readily writes to standard output — plugin warnings, deprecation
# messages, update banner. Just one of these messages would corrupt the JSON
# the caller expects. Everything therefore goes to standard error, and only
# `respond` writes to the real output.
$stdout = $stderr

begin
  require "fastlane"
rescue LoadError => e
  fail_with("fastlane is not available in this Ruby environment (#{e.message})")
end

def collect_lanes(fastfile_path)
  # Loading a Fastfile *runs* it, and its top level may call actions —
  # `default_platform(:ios)` is on the first line of most real Fastfiles. Without
  # the action catalogue loaded first, fastlane raises "Could not find action,
  # lane or variable" and the whole lane list is lost over an ordinary line.
  Fastlane.load_actions

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

require "prism"

# Literal values only, resolved by node type through a table.
#
# A Fastfile is arbitrary Ruby: `ENV["X"]` or a method call has no value until
# the lane runs, and a checklist that guesses is worse than one that stays quiet
# — it would be believed. Deciding from the node type rather than the converted
# value is also what keeps `false` and `nil` from being mistaken for absence.
LITERALS = {
  Prism::StringNode  => ->(n) { n.unescaped },
  Prism::SymbolNode  => ->(n) { n.unescaped },
  Prism::IntegerNode => ->(n) { n.value },
  Prism::FloatNode   => ->(n) { n.value },
  Prism::TrueNode    => ->(_) { true },
  Prism::FalseNode   => ->(_) { false },
  Prism::NilNode     => ->(_) { nil }
}.freeze

def literal_args(call)
  hash = (call.arguments&.arguments || []).find { |a| a.is_a?(Prism::KeywordHashNode) }
  return {} unless hash

  hash.elements.each_with_object({}) do |el, out|
    next unless el.is_a?(Prism::AssocNode) && el.key.is_a?(Prism::SymbolNode)
    reader = LITERALS[el.value.class]
    out[el.key.unescaped] = reader.call(el.value) if reader
  end
end

# Every call inside a lane's block, however deeply nested: a call inside an `if`
# is still a call the lane may make, and the checklist cares about what could
# happen, not only about what always happens.
def calls_within(node, out = [])
  node.compact_child_nodes.each do |child|
    if child.is_a?(Prism::CallNode) && child.receiver.nil?
      out << { name: child.name.to_s, args: literal_args(child) }
    end
    calls_within(child, out)
  end
  out
end

def collect_uses(fastfile_path)
  result = Prism.parse(File.read(fastfile_path))
  raise "Fastfile could not be parsed" unless result.success?

  lanes = []
  walk = lambda do |node|
    node.compact_child_nodes.each do |child|
      if child.is_a?(Prism::CallNode) && %w[lane private_lane].include?(child.name.to_s)
        name = child.arguments&.arguments&.first
        lanes << {
          lane: name.is_a?(Prism::SymbolNode) ? name.unescaped : "?",
          actions: child.block ? calls_within(child.block) : []
        }
      else
        # Not a lane: keep descending, so a `platform :ios do` block is seen through.
        walk.call(child)
      end
    end
  end
  walk.call(result.value)
  lanes
end

case command
when "lanes"
  begin
    lanes = collect_lanes(fastfile_path)
  rescue Exception => e # rubocop:disable Lint/RescueException
    # A Fastfile is arbitrary Ruby: loading it can raise anything at all,
    # including syntax errors that don't descend from StandardError.
    #
    # Careful: the success case's `respond` must stay OUTSIDE this
    # begin/rescue. `respond` ends with `exit 0`, which raises SystemExit —
    # a subclass of Exception, so caught by this `rescue Exception` if the
    # call is made inside. The symptom is a second JSON blob (the "exit"
    # error) written right after the first, which corrupts the output on
    # the caller's side.
    fail_with("Could not load the Fastfile: #{e.message}")
  end
  respond({ ok: true, lanes: lanes })
when "uses"
  begin
    lanes = collect_uses(fastfile_path)
  rescue Exception => e # rubocop:disable Lint/RescueException
    # Same shape as "lanes" above, and the same reason: parsing can raise
    # anything, and `respond`'s `exit 0` must not be caught by this rescue.
    fail_with("Could not parse the Fastfile: #{e.message}")
  end
  respond({ ok: true, lanes: lanes })
else
  fail_with("Unknown command: #{command.inspect}")
end
