bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"

cat /usr/local/community-scripts/defaults/debian.vars
# App-specific defaults for Debian (debian)
# Generated on 2026-02-15T16:51:42Z

var_unprivileged=0
var_cpu=2
var_ram=3072
var_disk=10
var_brg=vmbr0
var_net=192.168.2.11/24
var_gateway=192.168.2.1
var_ipv6_method=auto
var_ssh=yes
var_apt_cacher=no
var_fuse=no
var_tun=no
var_gpu=no
var_nesting=1
var_keyctl=0
var_mknod=0
var_protection=no
var_timezone=Europe/Berlin
var_tags=
var_verbose=yes
var_hostname=smarthome.xxx.xx
var_template_storage=local
var_container_storage=Raid6-1

/mnt/smarthome mit 16GB zusätzlich einhängen.
/mnt/smarthome/homeassistant/config/backups mit 30Gb zusätzlich einhängen.

msg_info "Installing Podman"
$STD apt install -y podman
systemctl enable -q --now podman.socket
echo -e 'unqualified-search-registries=["docker.io"]' >>/etc/containers/registries.conf
msg_ok "Installed Podman"

read -r -p "${TAB3}Would you like to add Portainer? <y/N> " prompt
mkdir -p /mnt/smarthome/portainer
if [[ ${prompt,,} =~ ^(y|yes)$ ]]; then
  msg_info "Installing Portainer $PORTAINER_LATEST_VERSION"
  podman volume create portainer_data >/dev/null
  $STD podman run -d \
    -p 8000:8000 \
    -p 9443:9443 \
    --name=portainer \
    --restart=always \
    -v /run/podman/podman.sock:/var/run/docker.sock \
    -v /mnt/smarthome/portainer:/data \
    portainer/portainer-ce:latest
  msg_ok "Installed Portainer $PORTAINER_LATEST_VERSION"
fi

mkdir -p /mnt/smarthome/mosquitto/config
ln -s /mnt/smarthome/mosquitto/config /var/log/mosquitto/

mkdir -p /mnt/smarthome/evcc/evcc-user
ln -s /mnt/smarthome/evcc/evcc-user /var/lib/evcc
touch /mnt/smarthome/evcc/evcc.yaml
ln -s /mnt/smarthome/evcc/evcc.yaml /etc/evcc.yaml


mkdir -p /mnt/smarthome/homeassistant/config
podman run -d --net host  --name homeassistant -v /dev:/dev -v /etc/localtime:/etc/localtime:ro -v /etc/timezone:/etc/timezone:ro -v /run/dbus:/run/dbus:ro -v /mnt/smarthome/homeassistant/config:/config -v /mnt/smarthome/homeassistant/config/backups:/config/backups --restart unless-stopped --privileged ghcr.io/home-assistant/home-assistant:stable

podman generate systemd \
  --new --name homeassistant \
  >/etc/systemd/system/homeassistant.service
systemctl enable -q --now homeassistant

mkdir -p /mnt/smarthome/familylink-auth
podman run -d --name familylink-auth -p 8099:8099 -p 5900:5900 -v /mnt/smarthome/familylink-auth:/share/familylink:rw -e LOG_LEVEL=info -e AUTH_TIMEOUT=300 -e SESSION_DURATION=86400 -e VNC_PASSWORD=familylink --restart unless-stopped --health-cmd CMD,curl,-f,http://localhost:8099/api/health --health-interval 30s --health-retries 3 --health-start-period 30s --health-timeout 10s ghcr.io/noiwid/familylink-auth:standalone

podman generate systemd \
  --new --name familylink-auth \
  >/etc/systemd/system/familylink-auth.service
systemctl enable -q --now familylink-auth

rm /mnt/smarthome/evcc/evcc.yaml
curl -1sLf 'https://dl.evcc.io/public/evcc/stable/setup.deb.sh' | sudo -E bash
apt update
apt install -y evcc


apt -y install mosquitto mosquitto-clients
