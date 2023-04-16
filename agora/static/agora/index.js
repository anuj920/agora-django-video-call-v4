const app = new Vue({
  el: "#app",
  delimiters: ["${", "}"],
  data: {
    callPlaced: false,
    client: null,
    localAudio: null,
    localVideo: null,
    mutedAudio: false,
    mutedVideo: false,
    userOnlineChannel: null,
    onlineUsers: [],
    incomingCall: false,
    incomingCaller: "",
    agoraChannel: null,
  },
  mounted() {
    this.initUserOnlineChannel();
  },

  methods: {
    initUserOnlineChannel() {
      const userOnlineChannel = pusher.subscribe("presence-online-channel");

      // Start Pusher Presence Channel Event Listeners

      userOnlineChannel.bind("pusher:subscription_succeeded", (data) => {
        // From Laravel Echo, wrapper for Pusher Js Client
        let members = Object.keys(data.members).map((k) => data.members[k]);
        this.onlineUsers = members;
      });

      userOnlineChannel.bind("pusher:member_added", (data) => {
        let user = data.info;
        // check user availability
        const joiningUserIndex = this.onlineUsers.findIndex(
          (data) => data.id === user.id
        );
        if (joiningUserIndex < 0) {
          this.onlineUsers.push(user);
        }
      });

      userOnlineChannel.bind("pusher:member_removed", (data) => {
        let user = data.info;
        const leavingUserIndex = this.onlineUsers.findIndex(
          (data) => data.id === user.id
        );
        this.onlineUsers.splice(leavingUserIndex, 1);
      });

      userOnlineChannel.bind("pusher:subscription_error", (err) => {
        console.log("Subscription Error", err);
      });

      userOnlineChannel.bind("an_event", (data) => {
        console.log("a_channel: ", data);
      });

      userOnlineChannel.bind("make-agora-call", (data) => {
        // Listen to incoming call. This can be replaced with a private channel

        if (parseInt(data.userToCall) === parseInt(AUTH_USER_ID)) {
          const callerIndex = this.onlineUsers.findIndex(
            (user) => user.id === data.from
          );
          this.incomingCaller = this.onlineUsers[callerIndex]["name"];
          this.incomingCall = true;

          // the channel that was sent over to the user being called is what
          // the receiver will use to join the call when accepting the call.
          this.agoraChannel = data.channelName;
        }
      });
    },

    getUserOnlineStatus(id) {
      const onlineUserIndex = this.onlineUsers.findIndex(
        (data) => data.id === id
      );
      if (onlineUserIndex < 0) {
        return "Offline";
      }
      return "Online";
    },

    async placeCall(id, calleeName) {
      try {
        // channelName = the caller's and the callee's id. you can use anything. tho.
        const channelName = `${AUTH_USER}_${calleeName}`;
        const tokenRes = await this.generateToken(channelName);

        // // Broadcasts a call event to the callee and also gets back the token
        let placeCallRes = await axios.post(
          "/call-user/",
          {
            user_to_call: id,
            channel_name: channelName,
          },
          {
            headers: {
              "Content-Type": "application/json",
              "X-CSRFToken": CSRF_TOKEN,
            },
          }
        );

        this.initializeAgora();
        this.joinRoom(tokenRes.data.appID, tokenRes.data.token, channelName);
      } catch (error) {
        console.log(error);
      }
    },

    async acceptCall() {
      const tokenRes = await this.generateToken(this.agoraChannel);
      this.initializeAgora();

      this.joinRoom(
        tokenRes.data.appID,
        tokenRes.data.token,
        this.agoraChannel
      );
      this.incomingCall = false;
      this.callPlaced = true;
    },

    declineCall() {
      // You can send a request to the caller to
      // alert them of rejected call
      this.incomingCall = false;
    },

    generateToken(channelName) {
      return axios.post(
        "/token/",
        {
          channelName,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": CSRF_TOKEN,
          },
        }
      );
    },

    /**
     * Agora Events and Listeners
     */
    initializeAgora() {
      this.client = AgoraRTC.createClient({ mode: "rtc", codec: "h264" });
    },

    async joinRoom(appID, token, channel) {
      try {
        console.log(appID, channel, token, AUTH_USER, "Join");
        const uid = await this.client.join(appID, channel, token, AUTH_USER);
        console.log("join success");
        this.callPlaced = true;
        this.createLocalStream();
        this.initializedAgoraListeners();
      } catch (e) {
        console.log("join failed", e);
      }
    },

    initializedAgoraListeners() {
      this.client.on("user-published", async (remoteUser, mediaType) => {
        console.log("published", user, type);
        await this.client.subscribe(remoteUser, mediaType);
        if (mediaType == "video") {
          console.log("subscribe video success");
          remoteUser.videoTrack.play("remote-video");
        }
        if (mediaType == "audio") {
          console.log("subscribe audio success");
          remoteUser.audioTrack.play();
        }
      });

      this.client.on("user-unpublished", async (remoteUser, mediaType) => {
        console.log("unpublished", user, type);
        if (mediaType == "video") {
          console.log("unpublished video success");
        }
        if (mediaType == "audio") {
          console.log("unpublished audio success");
          remoteUser.audioTrack.stop();
        }
      });

      this.client.on("user-left", (user) => {
        console.log("leaving", user);
      });

      this.client.on("user-info-updated", async (remoteUser, updateMsg) => {
        console.log("user info updated", remoteUser, updateMsg);
      });
    },

    async createLocalStream() {
      try {
        this.localAudio = await AgoraRTC.createMicrophoneAudioTrack();
      } catch (e) {
        console.log("create local audio track failed", e)
        this.localAudio = undefined;
      }
      try {
        this.localVideo = await AgoraRTC.createCameraVideoTrack();
      } catch (e) {
        console.log("create local video track failed", e)
        this.localVideo = undefined;
      }
      console.log("create local audio/video track success");

      this.localVideo.play("local-video");

      try {
        // Remove this line if the channel profile is not live broadcast.
        await this.client.setClientRole("host");
        await this.client.publish([this.localAudio, this.localVideo]);
        console.log("publish success");
      } catch (e) {
        console.log("publish failed", e);
      }
    },

    endCall() {
      this.localAudio?.close();
      this.localVideo?.close();
      this.client.leave(
        () => {
          console.log("Leave channel successfully");
          this.callPlaced = false;
        },
        (err) => {
          console.log("Leave channel failed");
        }
      );
      window.pusher.unsubscribe();
    },

    handleAudioToggle() {
      if (this.mutedAudio) {
        this.localAudio?.setEnabled(true);
        this.mutedAudio = false;
      } else {
        this.localAudio?.setEnabled(false);
        this.mutedAudio = true;
      }
    },

    handleVideoToggle() {
      console.log(this.mutedVideo, 'mutedVideo')
      if (this.mutedVideo) {
        this.localVideo?.setEnabled(true);
        this.mutedVideo = false;
      } else {
        this.localVideo?.setEnabled(false);
        this.mutedVideo = true;
      }
    },
  },
});
