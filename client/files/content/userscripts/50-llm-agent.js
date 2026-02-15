// ==UserScript==
// @name         LLM Game Agent
// @description  Connects to a local or remote LLM API for AI-assisted game management
// @author       TSO Client
// ==/UserScript==

(function() {
    'use strict';

    // ========================
    // Configuration defaults
    // ========================
    var llmDefaultConfig = {
        apiEndpoint: 'http://localhost:1234/v1/chat/completions',
        apiType: 'lmstudio',  // 'lmstudio', 'ollama', 'openai_compat', 'openai', 'anthropic'
        apiKey: '',
        model: '',
        maxTokens: 2048,
        systemPrompt: 'You are a game assistant for The Settlers Online. You help the player manage their settlement by analyzing game state and providing strategic advice.\n\nYou can execute game commands by including JSON code blocks in your responses:\n```json\n{"command": "getResources"}\n```\n```json\n{"command": "getBuildings"}\n```\n```json\n{"command": "getSpecialists"}\n```\n```json\n{"command": "getBuffs"}\n```\n```json\n{"command": "getSummary"}\n```\n```json\n{"command": "scrollToBuilding", "args": {"name": "PartialBuildingName"}}\n```\n```json\n{"command": "chatMessage", "args": {"message": "Hello!"}}\n```\n```json\n{"command": "showAlert", "args": {"message": "Notice!"}}\n```\n\nAvailable commands: getResources, getBuildings, getSpecialists, getBuffs, getSummary, scrollToBuilding, chatMessage, showAlert.\n\nWhen the user asks about their game state, use the appropriate command to fetch data. Always analyze the game state provided with the user message before suggesting actions. Be concise and strategic in your advice.',
        enabled: false
    };

    var llmAgent = null;
    var llmModal = null;

    // ========================
    // Game State Collector
    // ========================
    var LLMGameState = {
        getResources: function() {
            try {
                var res = game.getResources();
                if (!res) return { error: 'No resources available' };
                var result = {};
                for (var i = 0; i < res.length; i++) {
                    try {
                        var name = res[i].name_string;
                        var amount = res[i].getAmount();
                        if (amount > 0) result[name] = amount;
                    } catch(e) {}
                }
                return result;
            } catch(e) { return { error: e.toString() }; }
        },

        getBuildings: function() {
            try {
                var buildings = game.getBuildings();
                if (!buildings) return [];
                var result = [];
                var counts = {};
                for (var i = 0; i < buildings.length; i++) {
                    try {
                        var name = buildings[i].getName();
                        counts[name] = (counts[name] || 0) + 1;
                    } catch(e) {}
                }
                for (var n in counts) {
                    result.push({ name: n, count: counts[n] });
                }
                return result;
            } catch(e) { return { error: e.toString() }; }
        },

        getSpecialists: function() {
            try {
                var specs = game.getSpecialists();
                if (!specs) return [];
                var result = [];
                for (var i = 0; i < specs.length; i++) {
                    try {
                        result.push({
                            name: specs[i].getName(false).replace(/(<([^>]+)>)/gi, ""),
                            type: specs[i].GetType()
                        });
                    } catch(e) {}
                }
                return result;
            } catch(e) { return { error: e.toString() }; }
        },

        getBuffs: function() {
            try {
                var buffs = game.getBuffs();
                if (!buffs) return [];
                var result = [];
                for (var i = 0; i < buffs.length; i++) {
                    try {
                        result.push({
                            name: loca.GetText("SHI", buffs[i].getName()),
                            count: buffs[i].getAmount ? buffs[i].getAmount() : 1
                        });
                    } catch(e) {}
                }
                return result;
            } catch(e) { return { error: e.toString() }; }
        },

        getSummary: function() {
            var buildingCount = 0;
            var specCount = 0;
            try { buildingCount = game.getBuildings().length; } catch(e) {}
            try { specCount = game.getSpecialists().length; } catch(e) {}
            return {
                playerName: game.playerName,
                gameWorld: game.gw,
                playerLevel: (function() { try { return swmmo.application.mGameInterface.mHomePlayer.GetPlayerLevel(); } catch(e) { return 'unknown'; } })(),
                buildingCount: buildingCount,
                specialistCount: specCount,
                topResources: (function() {
                    var res = LLMGameState.getResources();
                    if (res.error) return res;
                    // Return top 20 resources by amount
                    var sorted = [];
                    for (var k in res) { sorted.push({ name: k, amount: res[k] }); }
                    sorted.sort(function(a, b) { return b.amount - a.amount; });
                    var top = {};
                    for (var i = 0; i < Math.min(20, sorted.length); i++) {
                        top[sorted[i].name] = sorted[i].amount;
                    }
                    return top;
                })()
            };
        }
    };

    // ========================
    // Command Executor
    // ========================
    var LLMCommandExecutor = {
        allowedCommands: {
            'getResources': function() { return LLMGameState.getResources(); },
            'getBuildings': function() { return LLMGameState.getBuildings(); },
            'getSpecialists': function() { return LLMGameState.getSpecialists(); },
            'getBuffs': function() { return LLMGameState.getBuffs(); },
            'getSummary': function() { return LLMGameState.getSummary(); },
            'scrollToBuilding': function(args) {
                try {
                    var buildings = game.getBuildings();
                    for (var i = 0; i < buildings.length; i++) {
                        if (buildings[i].getName().toLowerCase().indexOf(args.name.toLowerCase()) >= 0) {
                            game.zone.ScrollToGrid(buildings[i].GetGrid());
                            game.gi.SelectBuilding(buildings[i]);
                            return { success: true, building: buildings[i].getName() };
                        }
                    }
                    return { success: false, error: 'Building not found: ' + args.name };
                } catch(e) { return { success: false, error: e.toString() }; }
            },
            'chatMessage': function(args) {
                game.chatMessage(args.message || '', 'llm');
                return { success: true };
            },
            'showAlert': function(args) {
                game.showAlert(args.message || '');
                return { success: true };
            }
        },

        parseAndExecute: function(response) {
            var cmdRegex = /```json\s*(\{[\s\S]*?\})\s*```/g;
            var match;
            var results = [];

            while ((match = cmdRegex.exec(response)) !== null) {
                try {
                    var cmd = JSON.parse(match[1]);
                    if (cmd.command && this.allowedCommands[cmd.command]) {
                        var result = this.allowedCommands[cmd.command](cmd.args || {});
                        results.push({ command: cmd.command, result: result });
                    } else {
                        results.push({ command: cmd.command || 'unknown', error: 'Unknown or disallowed command' });
                    }
                } catch(e) {
                    results.push({ error: 'Parse error: ' + e.toString() });
                }
            }

            return results;
        }
    };

    // ========================
    // LLM Client
    // ========================
    var LLMClient = function(config) {
        this.config = config;
        this.conversationHistory = [];
    };

    LLMClient.prototype = {
        send: function(userMessage, onSuccess, onError) {
            var self = this;
            var requestBody;
            var headers = { 'Content-Type': 'application/json' };
            var url = this.config.apiEndpoint;

            this.conversationHistory.push({ role: 'user', content: userMessage });

            var allMessages = [
                { role: 'system', content: this.config.systemPrompt }
            ].concat(this.conversationHistory);

            switch(this.config.apiType) {
                case 'lmstudio':
                    // LM Studio uses OpenAI-compatible API, no API key needed
                    var lmBody = {
                        messages: allMessages,
                        stream: false
                    };
                    if (this.config.model) lmBody.model = this.config.model;
                    if (this.config.maxTokens) lmBody.max_tokens = this.config.maxTokens;
                    requestBody = JSON.stringify(lmBody);
                    break;

                case 'ollama':
                    requestBody = JSON.stringify({
                        model: this.config.model,
                        messages: allMessages,
                        stream: false
                    });
                    break;

                case 'openai_compat':
                    // Generic OpenAI-compatible server (vLLM, text-generation-webui, etc.)
                    if (this.config.apiKey) headers['Authorization'] = 'Bearer ' + this.config.apiKey;
                    var compatBody = {
                        messages: allMessages,
                        stream: false
                    };
                    if (this.config.model) compatBody.model = this.config.model;
                    if (this.config.maxTokens) compatBody.max_tokens = this.config.maxTokens;
                    requestBody = JSON.stringify(compatBody);
                    break;

                case 'openai':
                    headers['Authorization'] = 'Bearer ' + this.config.apiKey;
                    requestBody = JSON.stringify({
                        model: this.config.model,
                        messages: allMessages,
                        max_tokens: this.config.maxTokens
                    });
                    break;

                case 'anthropic':
                    headers['x-api-key'] = this.config.apiKey;
                    headers['anthropic-version'] = '2023-06-01';
                    requestBody = JSON.stringify({
                        model: this.config.model,
                        max_tokens: this.config.maxTokens,
                        system: this.config.systemPrompt,
                        messages: this.conversationHistory
                    });
                    break;

                default:
                    onError('Unknown API type: ' + this.config.apiType);
                    return;
            }

            $.ajax({
                type: 'POST',
                url: url,
                data: requestBody,
                contentType: 'application/json',
                dataType: 'json',
                headers: headers,
                timeout: 120000,
                success: function(data) {
                    var response = self.extractResponse(data);
                    self.conversationHistory.push({ role: 'assistant', content: response });
                    // Keep history manageable (last 20 messages)
                    if (self.conversationHistory.length > 20) {
                        self.conversationHistory = self.conversationHistory.slice(-10);
                    }
                    onSuccess(response);
                },
                error: function(xhr, status, errorMsg) {
                    // Remove the failed user message from history
                    self.conversationHistory.pop();
                    var detail = '';
                    try { detail = xhr.responseText ? ' - ' + xhr.responseText.substring(0, 200) : ''; } catch(e) {}
                    onError('LLM Error (' + status + '): ' + errorMsg + detail);
                }
            });
        },

        extractResponse: function(data) {
            switch(this.config.apiType) {
                case 'ollama':
                    return data.message ? data.message.content : (data.response || JSON.stringify(data));
                case 'lmstudio':
                case 'openai_compat':
                case 'openai':
                    // All OpenAI-compatible APIs use the same response format
                    try { return data.choices[0].message.content; }
                    catch(e) { return JSON.stringify(data); }
                case 'anthropic':
                    try { return data.content[0].text; }
                    catch(e) { return JSON.stringify(data); }
                default:
                    return JSON.stringify(data);
            }
        },

        clearHistory: function() {
            this.conversationHistory = [];
        }
    };

    // ========================
    // UI - Chat Modal
    // ========================
    function llmMenuHandler(event) {
        $("div[role='dialog']:not(#llmAgentModal):visible").modal("hide");

        if (!llmModal) {
            llmModal = new Modal('llmAgentModal', 'LLM Game Agent');
            llmModal.removeHiding = false;
            llmModal.size = 'modal-lg';
            llmModal.create();

            var html = '<div class="container-fluid">';
            // Status bar
            html += '<div id="llmStatus" style="padding:4px 8px;margin-bottom:8px;border-radius:4px;font-size:11px;background:#2a2a3e;color:#aaa;">';
            html += '<span id="llmStatusText">Not connected</span>';
            html += ' | <a href="#" id="llmClearHistory" style="color:#ff9800;">Clear history</a>';
            html += '</div>';
            // Chat log
            html += '<div id="llmChatLog" style="height:350px;overflow-y:auto;background:#1a1a2e;color:#e0e0e0;padding:10px;border-radius:5px;font-family:monospace;font-size:12px;word-wrap:break-word;"></div>';
            // Input
            html += '<div style="display:flex;margin-top:8px;">';
            html += '<input type="text" id="llmInput" class="form-control" style="flex:1;margin-right:5px;" placeholder="Ask the LLM about your game...">';
            html += '<button class="btn btn-primary" id="llmSend" style="width:70px;">Send</button>';
            html += '</div>';
            // Quick actions
            html += '<div style="margin-top:6px;">';
            html += '<button class="btn btn-xs btn-default llmQuick" data-q="Give me a summary of my current game state">Summary</button> ';
            html += '<button class="btn btn-xs btn-default llmQuick" data-q="What resources am I low on? What should I prioritize producing?">Resources</button> ';
            html += '<button class="btn btn-xs btn-default llmQuick" data-q="List my specialists and suggest what tasks to assign them">Specialists</button> ';
            html += '<button class="btn btn-xs btn-default llmQuick" data-q="Analyze my buildings and suggest what to build or upgrade next">Buildings</button> ';
            html += '</div>';
            html += '</div>';

            llmModal.Body().html(html);

            // Add settings button
            llmModal.addSettingsButton(function() { llmSettingsHandler(); });

            // Bind events
            $('#llmSend').click(llmSendMessage);
            $('#llmInput').keyup(function(e) { if(e.keyCode == 13) llmSendMessage(); });
            $('#llmClearHistory').click(function(e) {
                e.preventDefault();
                if (llmAgent) llmAgent.clearHistory();
                $('#llmChatLog').empty();
                llmAppendChat('System', 'Conversation history cleared.', '#ffb74d');
            });
            $('.llmQuick').click(function() {
                $('#llmInput').val($(this).data('q'));
                llmSendMessage();
            });

            updateLLMStatus();
        }

        llmModal.show();
    }

    function updateLLMStatus() {
        if (llmAgent) {
            var config = llmAgent.config;
            $('#llmStatusText').html('<span style="color:#4caf50;">Connected</span> - ' +
                config.apiType + ' / ' + config.model + ' (' + config.apiEndpoint + ')');
        } else {
            $('#llmStatusText').html('<span style="color:#f44336;">Not connected</span> - Open settings to configure');
        }
    }

    function llmSendMessage() {
        var input = $('#llmInput').val().trim();
        if (!input) return;

        if (!llmAgent) {
            llmAppendChat('System', 'LLM not configured. Click the settings icon to configure an API endpoint.', '#f44336');
            return;
        }

        $('#llmInput').val('');
        $('#llmSend').prop('disabled', true).text('...');
        llmAppendChat('You', input, '#4fc3f7');

        // Automatically include a compact game state summary with each message
        var stateInfo = JSON.stringify(LLMGameState.getSummary(), null, 2);
        var fullMessage = input + '\n\n[Current game state]\n' + stateInfo;

        llmAgent.send(fullMessage,
            function(response) {
                $('#llmSend').prop('disabled', false).text('Send');
                llmAppendChat('LLM', response, '#81c784');

                // Execute any embedded commands
                var results = LLMCommandExecutor.parseAndExecute(response);
                if (results.length > 0) {
                    llmAppendChat('System', 'Executed ' + results.length + ' command(s)', '#ffb74d');

                    // Send command results back to the LLM for context
                    var resultsStr = JSON.stringify(results, null, 2);
                    llmAppendChat('System', '<pre>' + escapeHtml(resultsStr) + '</pre>', '#ffb74d');

                    llmAgent.send('Command execution results:\n' + resultsStr,
                        function(followUp) {
                            llmAppendChat('LLM', followUp, '#81c784');
                            // Execute any further commands in the follow-up
                            var moreResults = LLMCommandExecutor.parseAndExecute(followUp);
                            if (moreResults.length > 0) {
                                llmAppendChat('System', 'Executed ' + moreResults.length + ' more command(s): ' +
                                    JSON.stringify(moreResults, null, 2), '#ffb74d');
                            }
                        },
                        function(err) { llmAppendChat('Error', err, '#ef5350'); }
                    );
                }
            },
            function(error) {
                $('#llmSend').prop('disabled', false).text('Send');
                llmAppendChat('Error', error, '#ef5350');
            }
        );
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function llmAppendChat(sender, message, color) {
        var log = $('#llmChatLog');
        var time = new Date().toLocaleTimeString();
        var msgHtml = message.replace(/```json[\s\S]*?```/g, function(m) {
            return '<code style="color:#fff;background:#333;padding:2px 4px;border-radius:3px;">' +
                   escapeHtml(m) + '</code>';
        });
        // Convert newlines to <br> (but not inside <pre> tags)
        if (msgHtml.indexOf('<pre>') === -1) {
            msgHtml = msgHtml.replace(/\n/g, '<br>');
        }
        log.append('<div style="margin-bottom:6px;"><span style="color:' + color + ';font-weight:bold;">[' +
                   time + '] ' + sender + ':</span> ' + msgHtml + '</div>');
        log.scrollTop(log[0].scrollHeight);
    }

    // ========================
    // UI - Settings Modal
    // ========================
    function llmSettingsHandler() {
        var w = new Modal('llmAgentSettings', '');
        w.settings(function() {
            // Save
            var config = {
                apiEndpoint: w.withsBody('#llmEndpoint').val().trim(),
                apiType: w.withsBody('#llmApiType').val(),
                apiKey: w.withsBody('#llmApiKey').val().trim(),
                model: w.withsBody('#llmModel').val().trim(),
                maxTokens: parseInt(w.withsBody('#llmMaxTokens').val()) || 2048,
                systemPrompt: w.withsBody('#llmSystemPrompt').val(),
                enabled: w.withsBody('#llmEnabled').is(':checked')
            };
            settings.store(config, 'llm');
            initLLMAgent();
            updateLLMStatus();
            w.shide();
            game.showAlert('LLM Agent settings saved');
        });

        var config = $.extend({}, llmDefaultConfig, settings.read(null, 'llm') || {});

        var apiTypeSelect = '<select id="llmApiType" class="form-control">' +
            '<option value="lmstudio">LM Studio (Local)</option>' +
            '<option value="ollama">Ollama (Local)</option>' +
            '<option value="openai_compat">OpenAI Compatible (Local/Custom)</option>' +
            '<option value="openai">OpenAI (Cloud)</option>' +
            '<option value="anthropic">Anthropic Claude (Cloud)</option>' +
            '</select>';

        var html = '<div class="container-fluid">';
        html += createTableRow([[4, 'API Type'], [8, apiTypeSelect]]);
        html += createTableRow([[4, 'Endpoint URL'], [8, '<input type="text" id="llmEndpoint" class="form-control" value="' + escapeHtml(config.apiEndpoint) + '">']]);
        html += createTableRow([[4, 'API Key'], [8, '<input type="password" id="llmApiKey" class="form-control" placeholder="Not needed for local servers (LM Studio, Ollama)" value="' + escapeHtml(config.apiKey) + '">']]);
        html += createTableRow([[4, 'Model'], [8, '<input type="text" id="llmModel" class="form-control" placeholder="Leave empty for LM Studio (uses loaded model)" value="' + escapeHtml(config.model) + '">']]);
        html += createTableRow([[4, 'Max Tokens'], [8, '<input type="number" id="llmMaxTokens" class="form-control" value="' + config.maxTokens + '">']]);
        html += createTableRow([[4, 'System Prompt'], [8, '<textarea id="llmSystemPrompt" class="form-control" rows="6">' + escapeHtml(config.systemPrompt) + '</textarea>']]);
        html += createTableRow([[4, 'Enabled'], [8, createSwitch('llmEnabled', config.enabled)]]);
        html += '<div style="margin-top:10px;padding:8px;background:#2a2a3e;border-radius:4px;font-size:11px;color:#aaa;">';
        html += '<b>Presets:</b> ';
        html += '<a href="#" class="llmPreset" data-type="lmstudio" data-url="http://localhost:1234/v1/chat/completions" data-model="" style="color:#4fc3f7;">LM Studio</a> | ';
        html += '<a href="#" class="llmPreset" data-type="ollama" data-url="http://localhost:11434/api/chat" data-model="llama3" style="color:#4fc3f7;">Ollama</a> | ';
        html += '<a href="#" class="llmPreset" data-type="openai_compat" data-url="http://localhost:8080/v1/chat/completions" data-model="" style="color:#4fc3f7;">OpenAI Compat</a> | ';
        html += '<a href="#" class="llmPreset" data-type="openai" data-url="https://api.openai.com/v1/chat/completions" data-model="gpt-4o" style="color:#4fc3f7;">OpenAI</a> | ';
        html += '<a href="#" class="llmPreset" data-type="anthropic" data-url="https://api.anthropic.com/v1/messages" data-model="claude-sonnet-4-20250514" style="color:#4fc3f7;">Anthropic</a>';
        html += '</div>';
        html += '</div>';

        w.sBody().html(html);
        w.withsBody('#llmApiType').val(config.apiType);

        // Preset click handlers
        w.withsBody('.llmPreset').click(function(e) {
            e.preventDefault();
            w.withsBody('#llmApiType').val($(this).data('type'));
            w.withsBody('#llmEndpoint').val($(this).data('url'));
            w.withsBody('#llmModel').val($(this).data('model'));
        });

        // Auto-fill endpoint when API type changes
        w.withsBody('#llmApiType').change(function() {
            var type = $(this).val();
            var endpoints = {
                'lmstudio': 'http://localhost:1234/v1/chat/completions',
                'ollama': 'http://localhost:11434/api/chat',
                'openai_compat': 'http://localhost:8080/v1/chat/completions',
                'openai': 'https://api.openai.com/v1/chat/completions',
                'anthropic': 'https://api.anthropic.com/v1/messages'
            };
            var models = {
                'lmstudio': '',
                'ollama': 'llama3',
                'openai_compat': '',
                'openai': 'gpt-4o',
                'anthropic': 'claude-sonnet-4-20250514'
            };
            w.withsBody('#llmEndpoint').val(endpoints[type] || '');
            w.withsBody('#llmModel').val(models[type] || '');
        });

        w.sshow();
    }

    // ========================
    // Initialization
    // ========================
    function initLLMAgent() {
        var config = $.extend({}, llmDefaultConfig, settings.read(null, 'llm') || {});
        if (config.enabled && config.apiEndpoint) {
            llmAgent = new LLMClient(config);
            game.chatMessage('LLM Agent initialized (' + config.apiType + ' / ' + config.model + ')', 'llm');
        } else {
            llmAgent = null;
        }
    }

    // Register in the Tools menu
    addToolsMenuItem("LLM Agent", llmMenuHandler, 120, true); // Ctrl+F9

    // Initialize agent from saved settings
    initLLMAgent();

})();
