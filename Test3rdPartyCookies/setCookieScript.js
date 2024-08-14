
const cookieInput = document.querySelector("#cookieInput");
const status = document.querySelector("#status");

function getCookie(c_name) {
    if (document.cookie.length > 0) {
        let c_start = document.cookie.indexOf(c_name + "=");
        if (c_start != -1) {
            c_start = c_start + c_name.length + 1;
            let c_end = document.cookie.indexOf(";", c_start);
            if (c_end == -1) {
                c_end = document.cookie.length;
            }
            return unescape(document.cookie.substring(c_start, c_end));
        }
    }
    return "";
}

cookieInput.value = getCookie('foo');

const setCookieButton = document.querySelector("#setCookie");
if (setCookieButton) setCookieButton.addEventListener('click', doSetCookies);

function doSetCookies() {
  // Chrome requires Secure and SameSite=None
  // Firefox and Safari default to SameSite=None anyway, but don't require Secure (I think they should!)
  document.cookie = 'foo=' + cookieInput.value + '; Secure; SameSite=None;'; 
  console.log('Cookies Set', document.cookie);
  status.innerText = 'Cookie set to: ' + document.cookie;
}
