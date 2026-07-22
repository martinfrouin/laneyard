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

# Every keyword this call was given, whether or not its value could be read.
#
# `args` deliberately holds literals only — a checklist that guessed at
# `ENV["X"]` would be believed. But dropping the whole entry loses something the
# literal value was never needed for: that the argument *was passed at all*.
#
# The two are not the same question, and treating them as one produced a
# visible inconsistency. A lane calling `app_store_connect_api_key(...)` was
# recognised by the action's name and reported as "could not tell", while the
# very same lane calling `upload_to_play_store(json_key: ENV.fetch("..."))` left
# no trace of `json_key` and was reported as having no credential at all — a
# warning and a shrug, for one situation.
def arg_names(call)
  hash = (call.arguments&.arguments || []).find { |a| a.is_a?(Prism::KeywordHashNode) }
  return [] unless hash

  hash.elements.filter_map do |el|
    el.key.unescaped if el.is_a?(Prism::AssocNode) && el.key.is_a?(Prism::SymbolNode)
  end
end

# How far a chain of helper methods is followed, and how the same method being
# called twice is kept from being walked twice. Eight is far past anything a
# real Fastfile does; the limit is there so that a pathological file costs a
# bounded walk rather than the checklist.
MAX_CALL_DEPTH = 8

# Every method this Fastfile defines, indexed by the name a call would use.
#
# `def deploy_ios` under "deploy_ios", and `def self.ship` inside `module
# Helpers` under "Helpers.ship". Both exist because both are how a real Fastfile
# is factored, and a Fastfile that factors its lanes is a well-written one — not
# an edge case. Reading only the lane bodies meant a project whose every action
# sat one method call away looked like a project that called no actions at all,
# and the Play Store check answered "no lane uploads to the Play Store" for a
# project that uploads to the Play Store on every run. A confident tick is worse
# than a warning: it is the one nobody checks.
def collect_defs(node, scope = nil, out = {})
  node.compact_child_nodes.each do |child|
    case child
    when Prism::ModuleNode, Prism::ClassNode
      # Its own scope, and nothing outside it needs to be walked again.
      collect_defs(child, child.constant_path.slice, out)
      next
    when Prism::DefNode
      key = child.receiver.nil? ? child.name.to_s : (scope ? "#{scope}.#{child.name}" : nil)
      out[key] = child.body if key
    end
    collect_defs(child, scope, out)
  end
  out
end

# The name a call would be indexed under, or nil when it cannot be one: a
# receiver that is itself computed (`thing.ship`) is not something a file can
# resolve, and guessing would be worse than the silence.
def resolvable_name(call)
  return call.name.to_s if call.receiver.nil?
  call.receiver.is_a?(Prism::ConstantReadNode) ? "#{call.receiver.slice}.#{call.name}" : nil
end

# Every call inside a lane's block, however deeply nested: a call inside an `if`
# is still a call the lane may make, and the checklist cares about what could
# happen, not only about what always happens.
#
# A call to a method this Fastfile defines is followed into that method, so the
# actions it makes are the lane's actions too — which is what they are. `seen`
# is the cycle guard: two helpers that call each other must cost one walk, not
# a stack overflow inside a checklist that promised never to throw.
# The name of the environment variable this call reads, or nil.
#
# `ENV.fetch("X")`, `ENV["X"]` and `ENV.fetch("X") { … }` are the forms that
# occur. A computed name — `ENV[some_var]` — is not a question this can answer,
# and is left out rather than guessed at.
def env_read(call)
  return nil unless call.receiver.is_a?(Prism::ConstantReadNode)
  return nil unless call.receiver.slice == "ENV"
  return nil unless %w[fetch []].include?(call.name.to_s)

  first = call.arguments&.arguments&.first
  first.is_a?(Prism::StringNode) ? first.unescaped : nil
end

def calls_within(node, defs, seen = [], out = [], env = [])
  return out if node.nil?

  node.compact_child_nodes.each do |child|
    if child.is_a?(Prism::CallNode)
      # Only receiverless calls are reported: `UI.message` and `File.join` are
      # Ruby, not fastlane, and a checklist reading them would be reading noise.
      if child.receiver.nil?
        out << { name: child.name.to_s, args: literal_args(child), given: arg_names(child) }
      end

      # The exception to the receiverless rule above, because it is not noise: a
      # variable the lane reads is a variable the run needs, and a run that meets
      # an absent one either stops or builds the wrong thing. It is the only
      # thing a Fastfile says about what the project requires from outside it.
      name = env_read(child)
      env << name if name

      key = resolvable_name(child)
      if key && defs.key?(key) && !seen.include?(key) && seen.length < MAX_CALL_DEPTH
        calls_within(defs[key], defs, seen + [key], out, env)
      end
    end
    calls_within(child, defs, seen, out, env)
  end
  out
end

# Does this Fastfile pull in lanes from somewhere else?
#
# `import` and `import_from_git` bring in another file's lanes, and no amount of
# reading this one will say what they call. Reported rather than resolved: the
# checklist turns it into "could not tell" instead of a tick, which is the whole
# difference between a checklist that is quiet and one that is wrong.
def imports_elsewhere?(source)
  source.lines.any? { |line| line.match?(/^\s*import(_from_git)?[\s(]/) }
end

def collect_uses(fastfile_path)
  source = File.read(fastfile_path)
  result = Prism.parse(source)
  raise "Fastfile could not be parsed" unless result.success?

  defs = collect_defs(result.value)
  lanes = []
  walk = lambda do |node|
    node.compact_child_nodes.each do |child|
      if child.is_a?(Prism::CallNode) && %w[lane private_lane].include?(child.name.to_s)
        name = child.arguments&.arguments&.first
        env = []
        actions = child.block ? calls_within(child.block, defs, [], [], env) : []
        lanes << {
          lane: name.is_a?(Prism::SymbolNode) ? name.unescaped : "?",
          actions: actions,
          env: env.uniq.sort
        }
      else
        # Not a lane: keep descending, so a `platform :ios do` block is seen through.
        walk.call(child)
      end
    end
  end
  walk.call(result.value)
  { lanes: lanes, imports: imports_elsewhere?(source) }
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
    used = collect_uses(fastfile_path)
  rescue Exception => e # rubocop:disable Lint/RescueException
    # Same shape as "lanes" above, and the same reason: parsing can raise
    # anything, and `respond`'s `exit 0` must not be caught by this rescue.
    fail_with("Could not parse the Fastfile: #{e.message}")
  end
  respond({ ok: true, lanes: used[:lanes], imports: used[:imports] })
else
  fail_with("Unknown command: #{command.inspect}")
end
