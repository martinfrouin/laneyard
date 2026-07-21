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
else
  fail_with("Unknown command: #{command.inspect}")
end
